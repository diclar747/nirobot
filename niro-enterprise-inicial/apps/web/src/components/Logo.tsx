export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 34 34"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="niro-logo-gradient" x1="0" y1="0" x2="34" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4f7dff" />
          <stop offset="1" stopColor="#2347b8" />
        </linearGradient>
      </defs>
      <rect width="34" height="34" rx="10" fill="url(#niro-logo-gradient)" />
      <path
        d="M10 22V12.6c0-.6.7-1 1.2-.6l10 8.9c.5.4 1.2 0 1.2-.6V11"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
