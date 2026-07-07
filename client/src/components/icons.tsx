// 管理画面用の最小限のラインアイコン(外部ライブラリ・他社UIのアイコンは使用しない)。
import type { SVGProps } from 'react';

function base(props: SVGProps<SVGSVGElement>) {
  return {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  };
}

export function IconYen(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M12 3 L7 11 M12 3 L17 11 M7 11 H17 M12 11 V21 M8.5 15 H15.5 M8.5 18 H15.5" />
    </svg>
  );
}

export function IconReceipt(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M6 3 H18 V21 L15.5 19 L13 21 L10.5 19 L8 21 L5.5 19 L6 21 V3 Z" />
      <path d="M9 8 H15 M9 12 H15 M9 16 H13" />
    </svg>
  );
}

export function IconBadge(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="9" r="6" />
      <path d="M8.5 14 L7 21 L12 18.5 L17 21 L15.5 14" />
    </svg>
  );
}

export function IconWallet(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10 H21" />
      <circle cx="16.5" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconBell(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20 L16 16" />
    </svg>
  );
}

export function IconGrid(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </svg>
  );
}

export function IconBox(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 8 L12 4 L20 8 L20 17 L12 21 L4 17 Z" />
      <path d="M4 8 L12 12 L20 8 M12 12 V21" />
    </svg>
  );
}

export function IconUpload(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M12 15 V4 M8 8 L12 4 L16 8" />
      <path d="M4 15 V19 A2 2 0 0 0 6 21 H18 A2 2 0 0 0 20 19 V15" />
    </svg>
  );
}

export function IconLink(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M9.5 14.5 L14.5 9.5" />
      <path d="M11 6.5 L13 4.5 A3.5 3.5 0 0 1 18 9.5 L16 11.5" />
      <path d="M13 17.5 L11 19.5 A3.5 3.5 0 0 1 6 14.5 L8 12.5" />
    </svg>
  );
}

export function IconChart(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 20 H20" />
      <rect x="6" y="12" width="3" height="8" />
      <rect x="11" y="7" width="3" height="13" />
      <rect x="16" y="10" width="3" height="10" />
    </svg>
  );
}

export function IconBuilding(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <path d="M9 7 H10 M14 7 H15 M9 11 H10 M14 11 H15 M9 15 H10 M14 15 H15" />
      <path d="M10 21 V17 H14 V21" />
    </svg>
  );
}

export function IconMegaphone(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 11 V15 H7 L15 19 V7 L7 11 Z" />
      <path d="M15 9 A3 3 0 0 1 15 17" />
      <path d="M7 15 L8.5 20" />
    </svg>
  );
}

export function IconDocument(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M7 3 H14 L18 7 V21 H7 Z" />
      <path d="M14 3 V7 H18" />
      <path d="M9.5 12 H15.5 M9.5 15.5 H15.5" />
    </svg>
  );
}

export function IconGear(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5 V6 M12 18 V20.5 M20.5 12 H18 M6 12 H3.5 M17.7 6.3 L16 8 M8 16 L6.3 17.7 M17.7 17.7 L16 16 M8 8 L6.3 6.3" />
    </svg>
  );
}

export function IconUser(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20 C5 15.5 8 13 12 13 C16 13 19 15.5 19 20" />
    </svg>
  );
}

export function IconHistory(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 10 A8 8 0 1 1 5.5 15.5" />
      <path d="M4 5 V10 H9" />
      <path d="M12 8 V12 L15 14" />
    </svg>
  );
}
