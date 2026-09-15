import { type FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { BrandMark, IconArrowRight, IconEye, IconEyeOff } from "./icons";
import { Button, IconButton } from "./ui";

/** Drifting points; a query point wanders among them and threads its nearest neighbours. */
function NeighbourField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    type Point = { x: number; y: number; vx: number; vy: number };
    let points: Point[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(160, Math.max(50, (width * height) / 9500)));
      points = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
      }));
    };

    const draw = (time: number) => {
      const t = time / 1000;
      ctx.clearRect(0, 0, width, height);
      const qx = width * (0.5 + 0.36 * Math.sin(t * 0.11));
      const qy = height * (0.5 + 0.32 * Math.sin(t * 0.17 + 1.2));
      if (!still) {
        for (const p of points) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < 0 || p.x > width) p.vx *= -1;
          if (p.y < 0 || p.y > height) p.vy *= -1;
        }
      }
      const nearest = points
        .map((p) => ({ p, d: (p.x - qx) ** 2 + (p.y - qy) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 8);
      const chosen = new Set(nearest.map((n) => n.p));

      nearest.forEach(({ p }, i) => {
        ctx.strokeStyle = `rgba(0, 113, 227, ${0.5 - i * 0.05})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(qx, qy);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      });
      for (const p of points) {
        const near = chosen.has(p);
        ctx.fillStyle = near ? "#0071e3" : "#d2d2d7";
        ctx.beginPath();
        ctx.arc(p.x, p.y, near ? 3.4 : 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(0, 113, 227, 0.12)";
      ctx.beginPath();
      ctx.arc(qx, qy, 18 + 4 * Math.sin(t * 2.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0071e3";
      ctx.beginPath();
      ctx.arc(qx, qy, 5.5, 0, Math.PI * 2);
      ctx.fill();

      // Keep the form calm: fade the field toward the centre.
      const glow = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.min(width, height) * 0.46);
      glow.addColorStop(0, "rgba(255,255,255,0.97)");
      glow.addColorStop(0.62, "rgba(255,255,255,0.86)");
      glow.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      if (!still) frame = requestAnimationFrame(draw);
    };

    resize();
    frame = requestAnimationFrame(draw);
    const onResize = () => {
      resize();
      if (still) requestAnimationFrame(draw);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={ref} className="field-canvas" aria-hidden="true" />;
}

export default function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim() || wait > 0) return;
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await api.login(key.trim()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setWait(err.retryAfter ?? 60);
        setError("Too many attempts from this network.");
      } else {
        setError(err instanceof ApiError && err.status === 401 ? "That key isn't valid. Check it and try again." : (err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <NeighbourField />
      <div className="signin-panel">
        <BrandMark size={60} />
        <h1>Sign in to NeedleDB</h1>
        <p className="signin-sub">Use an API key for this server. Your key stays on the server side of a secure session — it's never stored in the browser.</p>
        <form onSubmit={submit} className="signin-form">
          <label htmlFor="signin-key" className="sr-only">API key</label>
          <div className="key-input">
            <input id="signin-key" type={reveal ? "text" : "password"} autoFocus autoComplete="off" spellCheck={false}
              placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} aria-invalid={!!error} />
            <IconButton label={reveal ? "Hide key" : "Show key"} onClick={() => setReveal((r) => !r)}>
              {reveal ? <IconEyeOff size={18} /> : <IconEye size={18} />}
            </IconButton>
          </div>
          {error && (
            <div className="signin-error" role="alert">
              {error}{wait > 0 && ` Try again in ${wait}s.`}
            </div>
          )}
          <Button type="submit" variant="primary" size="lg" block disabled={busy || !key.trim() || wait > 0}
            icon={busy ? <span className="spinner" /> : undefined}>
            {busy ? "Signing in" : <>Continue <IconArrowRight size={18} /></>}
          </Button>
        </form>
        <p className="signin-foot">
          Admin keys come from <code>NEEDLEDB_API_KEY</code> or <code>needledb keys create</code>. New here? <a href="#/docs/guides/quickstart">Read the quickstart</a>.
        </p>
      </div>
      <div className="signin-corner">NeedleDB · self-hosted vector database</div>
    </main>
  );
}
