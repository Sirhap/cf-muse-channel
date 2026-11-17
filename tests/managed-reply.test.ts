import { expect, it } from "vitest";
import { channelReply } from "../src/managed/reply";

it("removes the standalone interactive widget from the actual WeChat reply without changing its prose", () => {
  const text = '你说的「你现在能干嘛」是指哪一个？\n\n• Muse 一般能干嘛\n• 这个对话里能帮你干嘛\n\n[[hatch_widget:widget-53a51478-a6c7-4b91-89d2-c4d852beee48]]';
  expect(channelReply(text)).toBe('你说的「你现在能干嘛」是指哪一个？\n\n• Muse 一般能干嘛\n• 这个对话里能帮你干嘛');
});

it("preserves ordinary brackets, quoted examples, and inline prose while handling a widget-only answer", () => {
  expect(channelReply('数组 []\n举例：[[hatch_widget:example]]\n[链接](https://example.com)')).toBe('数组 []\n举例：[[hatch_widget:example]]\n[链接](https://example.com)');
  expect(channelReply('  [[hatch_widget:widget-only]]  \r\n')).toBe('Muse 返回了交互组件，当前渠道暂不支持显示。');
});
