export function LogoIcon({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 270 270"
      xmlns="http://www.w3.org/2000/svg">
      <path
        fill="currentColor"
        d="M0 0 H270 V270 H210 V210 H60 V270 H0 V0 Z M60 60 H210 V150 H60 Z"
        fill-rule="evenodd"
      />
    </svg>
  );
}
