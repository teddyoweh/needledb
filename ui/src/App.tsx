import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Me, type Principal, type Role, onSignedOut } from "./api";
import Docs from "./docs/Docs";
import { BrandMark } from "./icons";
import { ROLE_RANK, useHashRoute } from "./lib";
import { type Session, SessionContext } from "./session";
import Shell from "./Shell";
import SignIn from "./SignIn";
import { ErrorNote, ToastProvider } from "./ui";

export default function App() {
  const { parts } = useHashRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any request that finds the session gone drops back to sign-in.
  useEffect(() => onSignedOut(() => setMe((m) => (m ? { authRequired: m.authRequired, authenticated: false } : m))), []);

  const session = useMemo<Session | null>(() => {
    if (!me?.authenticated || !me.principal) return null;
    const principal: Principal = me.principal;
    return {
      me: { ...me, principal },
      refresh,
      can: (role: Role) => ROLE_RANK[principal.role] >= ROLE_RANK[role],
      signOut: async () => {
        await api.logout().catch(() => undefined);
        setMe({ authRequired: me.authRequired, authenticated: false });
      },
    };
  }, [me, refresh]);

  // The docs are public: readable before signing in, and they hold no server data.
  if (parts[0] === "docs") return <Docs path={parts.slice(1)} signedIn={!!session} />;

  if (!me) {
    return (
      <div className="boot">
        {error ? <ErrorNote error={`Can't reach the NeedleDB server — ${error}`} /> : <div className="boot-mark"><BrandMark size={44} /></div>}
      </div>
    );
  }
  if (!session) return <SignIn onSignedIn={setMe} />;
  return (
    <SessionContext.Provider value={session}>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SessionContext.Provider>
  );
}
