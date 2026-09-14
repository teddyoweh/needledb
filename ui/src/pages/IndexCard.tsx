import type { IndexInfo } from "../api";
import { Sparkline } from "../charts";
import { IconBolt, IconChip, IconDisk } from "../icons";
import { fmtBytes, fmtCompact, structureLabel } from "../lib";
import { Badge } from "../ui";

export default function IndexCard({ info, qps, spark }: { info: IndexInfo; qps?: number; spark?: number[] }) {
  const ready = info.status.state === "Ready";
  return (
    <a className="index-card" href={`#/indexes/${encodeURIComponent(info.name)}`}>
      <div className="index-card-top">
        <span className="index-card-name">{info.name}</span>
        <Badge tone={ready ? "good" : "warn"} dot>{ready ? "Ready" : "Building"}</Badge>
      </div>
      <div className="index-card-meta">{info.dimension} dimensions · {info.metric} · {structureLabel(info)}</div>
      <div className="index-card-figure">
        <div>
          <span className="figure">{fmtCompact(info.vectorCount)}</span>
          <span className="figure-unit">{info.vectorCount === 1 ? "vector" : "vectors"}</span>
        </div>
        {spark && <Sparkline values={spark} width={104} height={36} />}
      </div>
      <div className="index-card-foot">
        <span title="Index memory"><IconChip size={14} />{fmtBytes(info.memoryBytes)}</span>
        <span title="On disk"><IconDisk size={14} />{fmtBytes(info.storageBytes)}</span>
        <span title="Queries per second"><IconBolt size={14} />{(qps ?? 0).toFixed(1)}/s</span>
      </div>
    </a>
  );
}
