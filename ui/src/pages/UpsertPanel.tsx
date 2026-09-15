import { useMemo, useState } from "react";
import { api, type IndexInfo } from "../api";
import { IconUpload } from "../icons";
import { fmtInt, randomUnitVector } from "../lib";
import { ModelBadge } from "../brands";
import { Button, Card, ErrorNote, Field, useToast } from "../ui";

const BATCH = 1000;
const TEXT_BATCH = 200;

type Parsed = { ok: true; records: Record<string, unknown>[] } | { ok: false; message: string };

function parseRecords(text: string, dimension: number, textField: string | null): Parsed {
  if (!text.trim()) return { ok: false, message: "Paste a JSON array of records, or insert an example." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "That isn't valid JSON." };
  }
  const records = Array.isArray(value) ? value : [value];
  if (!records.length) return { ok: false, message: "The array is empty." };
  for (const [i, rec] of records.entries()) {
    const where = `Record ${i + 1}`;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false, message: `${where} must be an object with id and values.` };
    const { id, values, metadata } = rec as Record<string, unknown>;
    if (typeof id !== "string" || !id) return { ok: false, message: `${where} needs a non-empty string id.` };
    const body = (rec as Record<string, unknown>).text ?? (textField ? (rec as Record<string, unknown>)[textField] : undefined);
    if (textField && values == null) {
      if (typeof body !== "string" || !body.trim()) return { ok: false, message: `${where} (${id}) needs text to embed, or values.` };
      if (metadata != null && (typeof metadata !== "object" || Array.isArray(metadata))) {
        return { ok: false, message: `${where} (${id}): metadata must be an object.` };
      }
      continue;
    }
    if (!Array.isArray(values) || !values.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return { ok: false, message: `${where} (${id}) needs values: an array of numbers.` };
    }
    if (values.length !== dimension) return { ok: false, message: `${where} (${id}) has ${values.length} values; this index is ${dimension}-dimensional.` };
    if (metadata != null && (typeof metadata !== "object" || Array.isArray(metadata))) {
      return { ok: false, message: `${where} (${id}): metadata must be an object.` };
    }
  }
  return { ok: true, records: records as Record<string, unknown>[] };
}

const TEXT_EXAMPLES = [
  { id: "film-1", text: "A concierge and his lobby boy are framed for murder in a grand mountain hotel.", metadata: { title: "The Grand Budapest Hotel", genre: "comedy", year: 2014 } },
  { id: "film-2", text: "A linguist is recruited to talk with aliens whose language changes how she sees time.", metadata: { title: "Arrival", genre: "drama", year: 2016 } },
  { id: "film-3", text: "A filmmaker forms an unlikely friendship with an octopus in a South African kelp forest.", metadata: { title: "My Octopus Teacher", genre: "documentary", year: 2020 } },
];

function example(dimension: number, embedded: boolean) {
  if (embedded) return `[\n${TEXT_EXAMPLES.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n]`;
  const docs = [
    { title: "The Grand Budapest Hotel", genre: "comedy", year: 2014 },
    { title: "Arrival", genre: "drama", year: 2016 },
    { title: "My Octopus Teacher", genre: "documentary", year: 2020 },
  ];
  const records = docs.map((metadata, i) => ({ id: `example-${i + 1}`, values: randomUnitVector(dimension), metadata }));
  return `[\n${records.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n]`;
}

export default function UpsertPanel({ info, namespaces, onDone }: { info: IndexInfo; namespaces: string[]; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [namespace, setNamespace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const textField = info.embed?.field ?? null;
  const parsed = useMemo(() => parseRecords(text, info.dimension, textField), [text, info.dimension, textField]);
  const batch = info.embed ? TEXT_BATCH : BATCH;

  async function submit() {
    if (!parsed.ok) return setError(parsed.message);
    setBusy(true);
    setError(undefined);
    try {
      let total = 0;
      for (let i = 0; i < parsed.records.length; i += batch) {
        total += (await api.upsert(info.name, parsed.records.slice(i, i + batch), namespace)).upsertedCount;
      }
      toast(`Upserted ${fmtInt(total)} ${total === 1 ? "record" : "records"}`, "good");
      setText("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card icon={<IconUpload size={16} />} title="Upsert records"
      subtitle={info.embed
        ? <>Send text and it's embedded with <ModelBadge embed={info.embed} size={14} />. New ids are inserted and existing ids replaced.</>
        : "New ids are inserted and existing ids replaced. Writes are durable before they're acknowledged."}
      actions={<Button size="sm" onClick={() => setText(example(info.dimension, !!info.embed))}>Insert example</Button>}>
      <div className="form">
        <Field label="Records" htmlFor="u-records"
          hint={text && !parsed.ok ? <span className="bad">{parsed.message}</span>
            : parsed.ok ? `${fmtInt(parsed.records.length)} valid ${parsed.records.length === 1 ? "record" : "records"}`
            : info.embed
              ? <>Each record: <code>{`{"id": "…", "text": "…", "metadata": {…}}`}</code>. The text is kept in metadata as <code>{info.embed.field}</code>.</>
              : <>Each record: <code>{`{"id": "…", "values": [${info.dimension} numbers], "metadata": {…}}`}</code></>}>
          <textarea id="u-records" rows={14} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={info.embed
              ? '[\n  {"id": "doc-1", "text": "Waterproof boots for muddy trails", "metadata": {"category": "outdoor"}}\n]'
              : '[\n  {"id": "doc-1", "values": [0.1, …], "metadata": {"title": "Hello"}}\n]'} />
        </Field>
        <div className="form-row">
          <Field label="Namespace" htmlFor="u-ns" hint="Pick one or type a new name.">
            <input id="u-ns" list="u-ns-list" value={namespace} placeholder="Default namespace" onChange={(e) => setNamespace(e.target.value)} />
            <datalist id="u-ns-list">{namespaces.filter(Boolean).map((ns) => <option key={ns} value={ns} />)}</datalist>
          </Field>
        </div>
        <ErrorNote error={error} />
        <div className="actions-end">
          <Button variant="primary" icon={<IconUpload size={16} />} onClick={() => void submit()} disabled={busy || !parsed.ok}>
            {busy ? "Upserting…" : "Upsert"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
