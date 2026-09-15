import { useState } from "react";
import { IconCheck, IconCopy } from "./icons";
import { copyText } from "./lib";

export type Lang = "python" | "bash" | "json" | "js";

type Token = { text: string; kind?: "kw" | "str" | "num" | "com" | "fn" | "key" | "flag" | "cmd" | "punct" };

const KEYWORDS: Record<Lang, Set<string>> = {
  python: new Set(["from", "import", "as", "def", "return", "for", "in", "if", "else", "elif", "with", "while", "class",
    "None", "True", "False", "and", "or", "not", "lambda", "await", "async", "try", "except", "raise", "pass", "print"]),
  js: new Set(["const", "let", "var", "function", "return", "await", "async", "import", "from", "export", "new", "if",
    "else", "for", "of", "in", "true", "false", "null", "undefined"]),
  bash: new Set(["export", "if", "then", "fi", "for", "do", "done", "in"]),
  json: new Set(["true", "false", "null"]),
};

const COMMANDS = new Set(["curl", "needledb", "pip", "uv", "docker", "python", "npm", "openssl", "caddy", "git"]);

const PATTERN = /(#[^\n]*|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?(?:e-?\d+)?\b)|(--?[a-zA-Z][\w-]*)|([A-Za-z_$][\w$]*)|([{}[\](),.:=<>+*/|\\-])|(\s+)|([\s\S])/g;

/** A tiny, dependency-free highlighter: enough for SDK snippets, shell and JSON. */
export function tokenize(code: string, lang: Lang): Token[] {
  const out: Token[] = [];
  const keywords = KEYWORDS[lang];
  let lineStart = true;
  for (const m of code.matchAll(PATTERN)) {
    const [text, comment, string, number, flag, word, punct, space] = m;
    const index = m.index ?? 0;
    if (comment && (lang === "python" || lang === "bash" ? comment.startsWith("#") : comment.startsWith("//"))) {
      out.push({ text, kind: "com" });
    } else if (string) {
      const isKey = lang === "json" || lang === "js" ? /^\s*:/.test(code.slice(index + text.length)) : false;
      out.push({ text, kind: isKey ? "key" : "str" });
    } else if (number) {
      out.push({ text, kind: "num" });
    } else if (flag && lang === "bash") {
      out.push({ text, kind: "flag" });
    } else if (word) {
      const next = code.slice(index + text.length);
      if (keywords.has(word)) out.push({ text, kind: "kw" });
      else if (lang === "bash" && lineStart && COMMANDS.has(word)) out.push({ text, kind: "cmd" });
      else if (/^\(/.test(next) && lang !== "bash" && lang !== "json") out.push({ text, kind: "fn" });
      else out.push({ text });
    } else if (punct) {
      out.push({ text, kind: "punct" });
    } else {
      out.push({ text });
    }
    if (space !== undefined) {
      if (text.includes("\n")) lineStart = true;
    } else {
      lineStart = false;
    }
  }
  return out;
}

function Highlighted({ code, lang }: { code: string; lang: Lang }) {
  return (
    <code>
      {tokenize(code, lang).map((t, i) => (t.kind ? <span key={i} className={`tok-${t.kind}`}>{t.text}</span> : t.text))}
    </code>
  );
}

function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="code-copy" aria-label={copied ? "Copied" : "Copy code"}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}>
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function CodeBlock({ code, lang, title }: { code: string; lang: Lang; title?: string }) {
  return (
    <div className="code-dark">
      <div className="code-bar">
        <span className="code-title">{title ?? lang}</span>
        <CopyCode text={code} />
      </div>
      <pre><Highlighted code={code} lang={lang} /></pre>
    </div>
  );
}

export function CodeTabs({ tabs }: { tabs: { label: string; lang: Lang; code: string }[] }) {
  const [active, setActive] = useState(0);
  const tab = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div className="code-dark">
      <div className="code-bar">
        <div className="code-tabs" role="tablist">
          {tabs.map((t, i) => (
            <button key={t.label} type="button" role="tab" aria-selected={i === active}
              className={i === active ? "on" : ""} onClick={() => setActive(i)}>{t.label}</button>
          ))}
        </div>
        <CopyCode text={tab.code} />
      </div>
      <pre><Highlighted code={tab.code} lang={tab.lang} /></pre>
    </div>
  );
}
