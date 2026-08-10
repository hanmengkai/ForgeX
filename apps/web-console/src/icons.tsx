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
