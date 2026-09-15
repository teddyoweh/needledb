import type { ReactNode, SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

const icon = (children: ReactNode) => (props: IconProps) => <Svg {...props}>{children}</Svg>;

export const IconOverview = icon(<><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></>);
export const IconIndexes = icon(<><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5V12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V5.5" /><path d="M4.5 12v6.5c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V12" /></>);
export const IconKey = icon(<><circle cx="8" cy="15.5" r="4" /><path d="m10.9 12.6 8.6-8.6" /><path d="m16.2 7.3 2.6 2.6" /><path d="m18.6 4.9 2 2" /></>);
export const IconShield = icon(<><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.1 7.5 9.5 4.4-1.4 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9 12 2 2 4-4" /></>);
export const IconSearch = icon(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.35-4.35" /></>);
export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);
export const IconCopy = icon(<><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" /></>);
export const IconCheck = icon(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconTrash = icon(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></>);
export const IconArrowRight = icon(<path d="M5 12h14M13 6l6 6-6 6" />);
export const IconChevronRight = icon(<path d="m9 6 6 6-6 6" />);
export const IconLogOut = icon(<><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="m10 16-4-4 4-4" /><path d="M6 12h10" /></>);
export const IconBolt = icon(<path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />);
export const IconClock = icon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const IconChip = icon(<><rect x="6" y="6" width="12" height="12" rx="2.5" /><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" /></>);
export const IconDisk = icon(<><rect x="3.5" y="4" width="17" height="16" rx="3" /><path d="M3.5 14h17" /><path d="M16.5 17h.01" /></>);
export const IconFilter = icon(<path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z" />);
export const IconSparkles = icon(<><path d="M11 3.5 12.6 8.4 17.5 10 12.6 11.6 11 16.5 9.4 11.6 4.5 10 9.4 8.4 11 3.5Z" /><path d="m18.5 14.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></>);
export const IconExternal = icon(<><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>);
export const IconX = icon(<path d="M6 6l12 12M18 6 6 18" />);
export const IconBook = icon(<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5" /></>);
export const IconUpload = icon(<><path d="M12 15V4M7 9l5-5 5 5" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>);
export const IconSliders = icon(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>);
export const IconLock = icon(<><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>);
export const IconGlobe = icon(<><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.5 3.5 5.3 3.5 8.5s-1.2 6-3.5 8.5c-2.3-2.5-3.5-5.3-3.5-8.5s1.2-6 3.5-8.5Z" /></>);
export const IconTarget = icon(<><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" /></>);
export const IconRows = icon(<><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth={2.5} /></>);
export const IconActivity = icon(<path d="M3 12h4l3-7 4 14 3-7h4" />);
export const IconCookie = icon(<><path d="M20.5 12.5A8.5 8.5 0 1 1 11.5 3.5a3 3 0 0 0 4 3 3 3 0 0 0 5 6Z" /><path d="M8.5 11.5h.01M12 16h.01M15.5 13.5h.01" strokeWidth={2.5} /></>);
export const IconGauge = icon(<><path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" /><path d="m12 13.5 4-5" /></>);
export const IconEye = icon(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>);
export const IconEyeOff = icon(<><path d="M3 3l18 18" /><path d="M10.6 5.6A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.3 6.9A16.5 16.5 0 0 0 2.5 12S6 18.5 12 18.5a9.5 9.5 0 0 0 4.3-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
export const IconReturn = icon(<><path d="M20 5v6a3 3 0 0 1-3 3H5" /><path d="m9 10-4 4 4 4" /></>);

export const IconChevronsUpDown = icon(<path d="m7 15 5 5 5-5M7 9l5-5 5 5" />);
export const IconHome = icon(<><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19v-8.5Z" /></>);
export const IconLogIn = icon(<><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" /><path d="m14 16 4-4-4-4" /><path d="M18 12H8" /></>);
export const IconTrendUp = icon(<><path d="m4 16 5-5 4 4 7-7" /><path d="M15 8h5v5" /></>);
export const IconTrendDown = icon(<><path d="m4 8 5 5 4-4 7 7" /><path d="M15 16h5v-5" /></>);
export const IconAlert = icon(<><path d="M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4M12 17h.01" /></>);
export const IconServer = icon(<><rect x="3.5" y="4" width="17" height="7" rx="2" /><rect x="3.5" y="13" width="17" height="7" rx="2" /><path d="M7.5 7.5h.01M7.5 16.5h.01" strokeWidth={2.5} /></>);
export const IconGrid = icon(<><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>);

/** The app mark: a needle threading one point out of many. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#1d1d1f" />
      <circle cx="9.5" cy="10" r="1.4" fill="#6e6e73" />
      <circle cx="22.5" cy="23" r="1.4" fill="#6e6e73" />
      <circle cx="10" cy="22" r="1.4" fill="#6e6e73" />
      <path d="M8.6 24.4 20.4 11.6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <ellipse cx="22.3" cy="9.5" rx="2.7" ry="1.55" transform="rotate(-47 22.3 9.5)" fill="none" stroke="#fff" strokeWidth="1.7" />
      <circle cx="22.3" cy="9.5" r="4.9" fill="none" stroke="#2997ff" strokeWidth="1.3" opacity=".9" />
    </svg>
  );
}
