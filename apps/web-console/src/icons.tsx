import type { ReactNode } from "react";

export const Icon = ({ children }: { children: ReactNode }) => (
  <span className="icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {children}
    </svg>
  </span>
);

export const SparkIcon = () => (
  <Icon>
    <path d="M12 2.7 13.8 8l5.4 1.8-5.4 1.8L12 17l-1.8-5.4-5.4-1.8L10.2 8 12 2.7Z" />
    <path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ArrowIcon = () => (
  <Icon>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m5 12 4.2 4.2L19 6.5" />
  </Icon>
);

export const DashboardIcon = () => (
  <Icon>
    <rect x="4" y="4" width="6" height="6" />
    <rect x="14" y="4" width="6" height="6" />
    <rect x="4" y="14" width="6" height="6" />
    <rect x="14" y="14" width="6" height="6" />
  </Icon>
);

export const RequirementIcon = () => (
  <Icon>
    <path d="M7 4h10l3 3v13H4V4h3Z" />
    <path d="M8 10h8M8 14h8M8 18h5" />
  </Icon>
);

export const AgentIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="13" rx="1" />
    <path d="M8 22h8M12 18v4M7 10h.01M11 10h6M7 14h10" />
  </Icon>
);

export const ApprovalIcon = () => (
  <Icon>
    <path d="M12 3 20 7v5c0 5-3.4 8-8 9-4.6-1-8-4-8-9V7l8-4Z" />
    <path d="m8.5 12 2.2 2.2 4.8-5" />
  </Icon>
);

export const ExtensionIcon = () => (
  <Icon>
    <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z" />
  </Icon>
);

export const UserIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c.7-4.1 3.3-6 8-6s7.3 1.9 8 6" />
  </Icon>
);

export const DownloadIcon = () => (
  <Icon>
    <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
  </Icon>
);

export const PulseIcon = () => (
  <Icon>
    <path d="M3 12h4l2-6 4 12 2-6h6" />
  </Icon>
);

export const MoonIcon = () => (
  <Icon>
    <path d="M20 15.2A8.4 8.4 0 0 1 8.8 4a8.4 8.4 0 1 0 11.2 11.2Z" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);
