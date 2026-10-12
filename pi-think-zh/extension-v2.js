"use strict";

const MARKER = "<io.github.duya07.think-zh/v2>";
// 去重正则同时认旧 id（local.pi-think-zh）：改 id 之前已经写进过 system prompt 的
// 块也要能被替换掉，否则新旧两段会并存、每轮再各追加一份。
const OWNED_BLOCK = /<(?:local\.pi-think-zh|io\.github\.duya07\.think-zh)\/(v[12])>[\s\S]*?<\/(?:local\.pi-think-zh|io\.github\.duya07\.think-zh)\/\1>/g;
const GUIDANCE = `${MARKER}
语言要求（适用于模型已公开返回的可见文字）：
1. 宿主“思考”区显示的 thinking、reasoning、reasoning_content 文字及推理摘要必须使用简体中文，从第一句开始；这不只是对最终回答的要求。
2. 用户问题、工具说明、代码或引用是英文时，不要因此切换思考区的叙述语言。若已开始用英文叙述，后续立即改用简体中文，不要先输出一段英文再翻译。
3. 计划、判断说明、工具调用前的进展和最终回答默认使用简体中文。用户明确指定某部分使用其他语言时，只对该部分按要求执行。
4. 代码、标识符、路径、命令、API 名称、原始错误和必要引用保持原文；中文解释与这些原文片段分开，不改写机器可执行内容。
5. 不要求披露隐藏推理，不改变其可见性，也不额外生成或伪造思考过程。这里只约束模型已公开返回、宿主能够显示的文字语言。
</io.github.duya07.think-zh/v2>`;

module.exports = function chineseVisibleReasoning(pi) {
  pi.on("before_agent_start", (event) => {
    if (typeof event?.systemPrompt !== "string") return undefined;
    const current = event.systemPrompt;
    let retained = false;
    const replaced = current.replace(OWNED_BLOCK, () => {
      if (retained) return "";
      retained = true;
      return GUIDANCE;
    });
    const next = retained ? replaced : `${current}\n\n${GUIDANCE}`;
    return next === current ? undefined : { systemPrompt: next };
  });
};
