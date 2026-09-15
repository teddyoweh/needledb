import type { ReactNode } from "react";
import type { Method } from "./parts";

export type DocPage = {
  slug: string;
  title: string;
  group: string;
  description?: string;
  method?: Method;
  keywords?: string;
  /** API pages lay out their own two columns and skip the table of contents. */
  wide?: boolean;
  render: () => ReactNode;
};
