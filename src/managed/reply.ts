/** Channel clients cannot render Muse's standalone interactive-widget directives. */
export function channelReply(text: string): string {
  const cleaned = text.split(/\r?\n/)
    .filter((line) => !/^\s*\[\[hatch_widget:[^\]\r\n]+\]\]\s*$/.test(line))
    .join("\n").trim();
  return cleaned || "Muse 返回了交互组件，当前渠道暂不支持显示。";
}
