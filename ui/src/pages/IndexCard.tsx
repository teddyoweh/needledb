import type { IndexInfo } from "../api";
import { IconChip, IconDisk, IconRows } from "../icons";
import { fmtBytes, fmtCompact, structureLabel } from "../lib";
import { Badge, IndexAvatar } from "../ui";

export default function IndexCard({ info }: { info: IndexInfo }) {
  const ready = info.status.state === "Ready";
  return (
    <a className="index-card" href={`#/indexes/${encodeURIComponent(info.name)}`}>
      <div className="index-card-top">
        <IndexAvatar name={info.name} size={38} />
        <Badge tone={ready ? "good" : "warn"}>{ready ? "Ready" : "Rebuilding"}</Badge>
      </div>
      <div className="index-card-name">{info.name}</div>
      <div className="index-card-meta">{info.dimension} dimensions · {info.metric} · {structureLabel(info)}</div>
      <div className="index-card-figure">
        <span className="figure">{fmtCompact(info.vectorCount)}</span>
        <span className="figure-unit">{info.vectorCount === 1 ? "vector" : "vectors"}</span>
      </div>
      <div className="index-card-foot">
        <span title="Index memory"><IconChip size={14} />{fmtBytes(info.memoryBytes)}</span>
        <span title="On disk"><IconDisk size={14} />{fmtBytes(info.storageBytes)}</span>
        <span title="Namespaces"><IconRows size={14} />{info.namespaceCount}</span>
      </div>
    </a>
  );
}
