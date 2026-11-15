#!/usr/bin/env python3
"""Audit and allow-once exact network approvals through the CF Noise connection."""
from __future__ import annotations
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit
from probe import RelayGateway, worker_origin


def normalize_host(value):
    if not isinstance(value,str) or not value or value != value.strip() or any(c in value for c in '/@%?#:'):
        raise ValueError('invalid_host')
    value=value.lower().removesuffix('.')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?',value) or '..' in value:
        raise ValueError('invalid_host')
    return value


def policy_rules(path):
    data=json.loads(path.read_text())
    if not isinstance(data,dict) or data.get('version')!=1 or not isinstance(data.get('rules'),list):
        raise ValueError('invalid_policy')
    rules=[]
    for rule in data['rules']:
        if not isinstance(rule,dict) or rule.get('scheme')!='https' or type(rule.get('port'))is not int or rule['port']!=443:
            raise ValueError('invalid_policy')
        host=normalize_host(rule.get('host'))
        methods=rule.get('methods')
        if not isinstance(methods,list)or not methods or any(m not in {'GET','HEAD','CONNECT'}for m in methods):
            raise ValueError('invalid_policy')
        threads=rule.get('thread_ids')
        if threads is not None and (not isinstance(threads,list)or not threads or any(not isinstance(t,str)or not t for t in threads)):
            raise ValueError('invalid_policy')
        rules.append({'host':host,'port':443,'scheme':'https','methods':methods,'thread_ids':threads})
    return rules


def unwrap(value):
    if not isinstance(value,dict):return {}
    for field in ['approval','record']:
        if isinstance(value.get(field),dict):return value[field]
    return value


def pending_records(response):
    if not isinstance(response,dict):raise ValueError('invalid_approval_list')
    rows=response.get('pending_approvals',response.get('pending',[]))
    if not isinstance(rows,list):raise ValueError('invalid_approval_list')
    return [unwrap(row)for row in rows]


def evaluate(record,rules,now_ms):
    """Use only structured target fields; descriptions and commands never authorize a host."""
    if not isinstance(record,dict):return False,'invalid_record'
    if record.get('status')not in (None,'pending','awaiting_approval'):return False,'not_pending'
    expiry=record.get('request_expires_at_ms')
    if type(expiry)not in (int,float)or not math.isfinite(expiry)or expiry<=now_ms:return False,'expired_or_missing_expiry'
    aid=record.get('approval_id')
    if not isinstance(aid,str)or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',aid):return False,'invalid_approval_id'
    try:host=normalize_host(record.get('host'))
    except ValueError:return False,'invalid_host'
    port=record.get('port')
    if isinstance(port,str)and port.isdecimal():port=int(port)
    if type(port)is not int:return False,'invalid_port'
    scheme=record.get('scheme','').lower()
    method=record.get('method','').upper()
    # Muse's HTTPS pre-connect approval is represented as TCP CONNECT, not an HTTP request.
    if scheme not in ('https','tls') and not(scheme=='tcp'and method=='CONNECT'and port==443):
        return False,'unsupported_scheme'
    for rule in rules:
        if host==rule['host']and port==rule['port']and method in rule['methods']:
            threads=rule.get('thread_ids')
            trace=record.get('runtime_request_trace')or{}
            if threads is not None and(not isinstance(trace,dict)or trace.get('thread_id')not in threads):
                return False,'task_scope_mismatch'
            return True,'exact_network_rule'
    return False,'no_matching_rule'


class ApprovalAudit:
    """Persist uncertainty before an RPC so a lost response can never cause replay."""
    def __init__(self,path):
        path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        descriptor=os.open(path,os.O_CREAT|os.O_RDWR,0o600);os.fchmod(descriptor,0o600);os.close(descriptor)
        self.db=sqlite3.connect(path,timeout=10,isolation_level=None)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY,state TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,started REAL NOT NULL,finished REAL)')
    def close(self):self.db.close()
    def claim(self,record):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            result=self.db.execute("INSERT OR IGNORE INTO decisions VALUES (?,'decision_unknown',?,?,?,NULL)",
                (record['approval_id'],record['host'],int(record['port']),time.time()))
            self.db.execute('COMMIT');return result.rowcount==1
        except BaseException:self.db.execute('ROLLBACK');raise
    def complete(self,aid):
        self.db.execute("UPDATE decisions SET state='rpc_accepted',finished=? WHERE id=? AND state='decision_unknown'",(time.time(),aid))


def process(client,rules,audit,apply=False,now=None):
    rows=pending_records(client.call_json('egress.approvals',timeout=20));results=[]
    for sparse in rows:
        aid=sparse.get('approval_id')
        if not isinstance(aid,str)or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}',aid):
            results.append({'action':'held','reason':'invalid_approval_id'});continue
        # Read fresh detail, not the screenshot or stale queued text, immediately before deciding.
        detail=unwrap(client.call_json('egress.approval',path_params={'approval_id':aid},timeout=20))
        if detail.get('approval_id')!=aid:
            results.append({'approval_id':aid,'action':'held','reason':'detail_identity_mismatch'});continue
        ok,reason=evaluate(detail,rules,int((time.time()if now is None else now)*1000))
        item={'approval_id':aid,'action':'would_allow_once'if ok else'held','reason':reason}
        if not ok:
            item['target']={key:detail.get(key)for key in ['host','port','scheme','method','status']}
        if ok:
            item.update(host=detail['host'],port=int(detail['port']))
            if apply:
                if not audit.claim(detail):item.update(action='held',reason='already_attempted_or_unknown')
                else:
                    try:
                        result=client.call_json('egress.approval.decide',path_params={'approval_id':aid},body={'decision':'allow_once'},timeout=20)
                        if not isinstance(result,dict)or result.get('ok')is False or result.get('error'):
                            raise ValueError('unconfirmed_decision_response')
                        audit.complete(aid);item['action']='rpc_accepted'
                    except Exception as error:
                        item.update(action='decision_unknown',error_type=type(error).__name__)
        results.append(item)
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',required=True);parser.add_argument('--policy',type=Path,required=True)
    parser.add_argument('--audit',type=Path,default=Path('.local/approval-audit.sqlite3'))
    parser.add_argument('--apply',action='store_true');parser.add_argument('--watch',action='store_true')
    parser.add_argument('--interval',type=int,default=15);parser.add_argument('--duration',type=int,default=3600)
    args=parser.parse_args()
    key=os.environ.get('DEMO_KEY','')
    try:
        worker_origin(args.url);rules=policy_rules(args.policy)
        if not 32<=len(key)<=512 or any(c.isspace()for c in key):raise ValueError('invalid_key')
        if not 5<=args.interval<=300 or not 1<=args.duration<=7200:raise ValueError('invalid_interval_or_duration')
    except (ValueError,OSError,TypeError,KeyError):parser.error('Invalid policy, origin, credential or polling limits')
    args.audit.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock=args.audit.with_suffix('.lock').open('a');os.fchmod(lock.fileno(),0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close();print(json.dumps({'error':'approval_watcher_already_running'}));return 1
    audit=ApprovalAudit(args.audit);deadline=time.monotonic()+args.duration
    try:
        while True:
            client=None
            try:
                client=RelayGateway(args.url,key)
                print(json.dumps({'checks':process(client,rules,audit,args.apply),'apply':args.apply},ensure_ascii=False),flush=True)
            except Exception as error:
                print(json.dumps({'error':'approval_poll_failed','error_type':type(error).__name__}),flush=True)
                if not args.watch:return 1
            finally:
                if client is not None:client.close()
            if not args.watch or time.monotonic()+args.interval>=deadline:break
            time.sleep(args.interval)
    finally:audit.close();lock.close()
    return 0


if __name__=='__main__':raise SystemExit(main())
