#!/usr/bin/env python3
"""Build one chat attachment from canonical rules, without runtime/Git instructions."""
import argparse
import hashlib
import posixpath
from pathlib import Path
import re

SECTIONS = (
    ('references/chat-attachment.md', 'chat-start', 'Notebook与普通聊天使用方法'),
    ('SKILL.md', 'engineering-rules', '工程范围、固定边界与完整流程'),
    ('references/optimization-map.md', 'methods', '11种通用方法与案例匹配'),
    ('references/cost-reduction.md', 'cases', '38条具体配置案例'),
    ('references/offline-prescreen.md', 'prescreen', '容量、几何、行程与机构联合比较'),
    ('references/calculation.md', 'calculation', '计算、流速与噪声的适用边界'),
    ('references/actuator-force-followup.md', 'actuator', '推力对照与改Cv后的负荷计算'),
    ('references/getting-started.md', 'delivery', '中文逐台交付规范'),
)

def between(text, start, end=None):
    text = text[text.index(start):]
    return text[:text.index(end)] if end else text

def build(source):
    source = Path(source)
    texts = {name: (source / name).read_text() for name, _, _ in SECTIONS}
    version = re.search(r'^  version: "([0-9]+\.[0-9]+\.[0-9]+)"$', texts['SKILL.md'], re.M)[1]
    anchors = {name: anchor for name, anchor, _ in SECTIONS}
    parts = [f'# 阀门优化：Copilot单文件指南\n\n版本：{version}。适用于Microsoft 365 Copilot Chat / Notebook。\n\n'
             '本文件含聊天使用约定、工程规则、11种通用方法和38条具体案例；不含客户数据、厂家曲线库、厂家PDF或可执行程序。完整Skill另行保存，本文不要求安装。\n\n'
             '先使用第一节的Notebook短指令与启动消息，再按任务读取工程章节。附件不会自动成为系统指令，实际执行仍需用户在聊天或Notebook指令中指定。\n\n## 目录\n\n']
    parts += [f'- [{title}](#{anchor})\n' for _, anchor, title in SECTIONS]
    for name, anchor, title in SECTIONS:
        body = texts[name]
        if name == 'SKILL.md':
            body = between(body, '## 任务范围', '## 工具与分发')
        elif name.endswith('optimization-map.md'):
            body = body.split('## Skill结构')[0]
        elif name.endswith('offline-prescreen.md'):
            body = body.split('## 当前工具能力与复用边界')[0]
        elif name.endswith('calculation.md'):
            body = ('本节公式来自完整Skill的固定初算方法；聊天中按前文计算备忘和实际可用工具执行。\n\n'
                    + between(body, '已有 Cv 公式', '## 候选检查器与输入')
                    + between(body, '## 数值可行与试选价值分开'))
        elif name.endswith('actuator-force-followup.md'):
            start, end = body.index('**可执行检查：**'), body.index('检查结果分别记录')
            body = body[:start] + '没有完整程序包时，按本节逐项建立人工核对表；不得声称自动检查器已运行。\n\n' + body[end:]
            body = body.split('经验证的通用方法写回本参考')[0]
        elif name.endswith('getting-started.md'):
            body = between(body, '## 正式输出规范', '## 给读取本文件的助手')
        body = re.sub(r'\A# [^\n]+\n', '', body).strip()
        # Executable helper references remain provenance, never attachment dependencies.
        body = re.sub(r'`scripts/[^`]+`', '完整版的对应检查程序（本MD未附；按上述项目人工核对）', body)
        def link(match):
            label, target = match.groups()
            if re.match(r'https?://|#', target):
                return match[0]
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target.split('#')[0]))
            if resolved in anchors:
                return f'[{label}](#{anchors[resolved]})'
            return f'{label}（完整包参考，本MD未附）'
        body = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, body)
        parts.append(f'\n\n---\n\n<a id="{anchor}"></a>\n\n## {title}\n\n{body}\n')
    parts.append('\n\n## 来源与版本核对\n\n本单文件由同版本维护源生成。省略了Git发布、环境安装、命令行调用和程序输入结构说明；未删减38条案例表及11种通用方法。工程来源指纹如下，文件名是来源记录，不是要求聊天打开本机文件。\n\n| 来源 | SHA-256 |\n| --- | --- |\n')
    parts += [f'| {name} | {hashlib.sha256(texts[name].encode()).hexdigest()} |\n' for name, _, _ in SECTIONS]
    text = ''.join(parts)
    if set(map(int, re.findall(r'^\| (\d+) \|', text, re.M))) != set(range(1, 39)):
        raise ValueError('missing case rows')
    if len(re.findall(r'^\| [1-3]\.\d+ \|', text, re.M)) != 11:
        raise ValueError('missing method rows')
    targets = re.findall(r'\]\((#[^)]+)\)', text)
    if any(t[1:] not in anchors.values() for t in targets):
        raise ValueError('unresolved internal link')
    return text

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    content = build(Path(__file__).resolve().parents[1])
    with Path(args.output).open('x') as target:
        target.write(content)
    print(f'{len(content.encode())} bytes; 11 methods; 38 cases')
