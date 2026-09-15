import type { AuditEvent } from "../api";
import { IconAlert, IconIndexes, IconKey, IconLogIn, IconShield } from "../icons";
import { describeEvent, fmtRelative } from "../lib";
import { Empty, Skeleton } from "../ui";

export function eventIcon(e: AuditEvent, size = 15) {
  if (!e.ok || e.action === "auth.blocked") return <IconAlert size={size} />;
  if (e.action.startsWith("key.")) return <IconKey size={size} />;
  if (e.action.startsWith("index.")) return <IconIndexes size={size} />;
  return <IconLogIn size={size} />;
}

export function ActivityFeed({ events }: { events?: AuditEvent[] }) {
  if (!events) {
    return <div className="stack tight pad">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={42} radius={10} />)}</div>;
  }
  if (!events.length) {
    return (
      <Empty icon={<IconShield size={22} />} title="No activity yet">
        Sign-ins, rejected keys and changes to keys and indexes are recorded here.
      </Empty>
    );
  }
  return (
    <ul className="feed">
      {events.map((e) => (
        <li key={e.id} className="feed-item">
          <span className={`feed-icon ${e.ok ? "" : "bad"}`}>{eventIcon(e)}</span>
          <div className="feed-text">
            <p>{describeEvent(e)}</p>
            <span>{fmtRelative(e.ts)}{e.ip ? ` · ${e.ip}` : ""}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
