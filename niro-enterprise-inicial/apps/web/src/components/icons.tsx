import type { SVGProps } from 'react';

function base(props: SVGProps<SVGSVGElement>) {
  return {
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props
  };
}

export function IconHome(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

export function IconUsers(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5" />
      <circle cx="17" cy="8.5" r="2.4" />
      <path d="M15.5 14.8c2.5.2 4.5 2.3 5 5.2" />
    </svg>
  );
}

export function IconLayers(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="m12 3 8 4.2-8 4.2-8-4.2Z" />
      <path d="m4 12 8 4.2 8-4.2" />
      <path d="m4 16.2 8 4.2 8-4.2" />
    </svg>
  );
}

export function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.3-2-3.4-2 .8a7.7 7.7 0 0 0-2.6-1.5L14 3h-4l-.5 2.1a7.7 7.7 0 0 0-2.6 1.5l-2-.8-2 3.4 1.7 1.3a7.6 7.6 0 0 0 0 3L3 14.8l2 3.4 2-.8c.8.7 1.6 1.2 2.6 1.5L10 21h4l.5-2.1a7.7 7.7 0 0 0 2.6-1.5l2 .8 2-3.4Z" />
    </svg>
  );
}

export function IconBuilding(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="4" width="10" height="17" rx="1" />
      <rect x="14" y="9" width="6" height="12" rx="1" />
      <path d="M7 8h1M7 12h1M7 16h1M10.5 8h1M10.5 12h1M10.5 16h1M16.5 12.5h1M16.5 16h1" />
    </svg>
  );
}

export function IconInbox(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M20 12.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-5.5" />
      <path d="M4 12.5h4.2c.3 0 .6.2.7.5l.6 1.5c.1.3.4.5.7.5h3.6c.3 0 .6-.2.7-.5l.6-1.5c.1-.3.4-.5.7-.5H20" />
      <path d="m6 12.5 1.8-6.9A1 1 0 0 1 8.75 5h6.5a1 1 0 0 1 .97.6l1.8 6.9" />
    </svg>
  );
}

export function IconSend(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4.5 12 20 4l-6 16-3-6.5Z" />
      <path d="M14 13.5 20 4" />
    </svg>
  );
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.3-4.3" />
    </svg>
  );
}

export function IconNote(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M14.5 4.2V8a1 1 0 0 0 1 1h3.8" />
      <path d="M8 13h8M8 16.5h5" />
    </svg>
  );
}

export function IconPackage(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="m3.5 7.5 8.5-4 8.5 4-8.5 4-8.5-4Z" />
      <path d="M3.5 7.5V16l8.5 4 8.5-4V7.5" />
      <path d="M12 11.5V20" />
      <path d="m7 5.6 8.5 4" />
    </svg>
  );
}

export function IconAttach(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M17.5 9.5 10 17a3 3 0 0 1-4.2-4.2l8-8a2 2 0 1 1 2.9 2.9l-7.6 7.6a1 1 0 0 1-1.4-1.4l6.9-6.9" />
    </svg>
  );
}

export function IconFile(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    </svg>
  );
}

export function IconChart(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7" y="12" width="3" height="8" rx="0.5" />
      <rect x="12.5" y="8" width="3" height="12" rx="0.5" />
      <rect x="17" y="5" width="3" height="15" rx="0.5" />
    </svg>
  );
}

export function IconLogout(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M9 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3" />
      <path d="M15 16.5 20 12l-5-4.5" />
      <path d="M9 12h11" />
    </svg>
  );
}
