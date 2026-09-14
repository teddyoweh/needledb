import { createContext, useContext } from "react";
import type { Me, Principal, Role } from "./api";

export type Session = {
  me: Me & { principal: Principal };
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (role: Role) => boolean;
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside SessionContext");
  return session;
}
