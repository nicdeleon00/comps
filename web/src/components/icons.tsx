// Line icons drawn on a 24px grid, 1.7px stroke, to sit next to SF text.
import type { JSX } from 'preact';

type P = JSX.SVGAttributes<SVGSVGElement> & { size?: number };

const make = (paths: JSX.Element, fill = false) => ({ size = 20, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...p}>{paths}</svg>
);

export const IconMarket = make(<><path d="M3.5 19.5h17" /><path d="M5 15.5l4.2-4.6 3.6 3 6.2-7.4" /><path d="M15.6 6.5H19v3.4" /></>);
export const IconTag = make(<><path d="M3.8 12.7V5.3c0-.8.7-1.5 1.5-1.5h7.4c.4 0 .8.2 1.1.4l6.4 6.4c.6.6.6 1.5 0 2.1l-7.4 7.4c-.6.6-1.5.6-2.1 0l-6.4-6.4c-.3-.3-.5-.7-.5-1z" /><circle cx="8.3" cy="8.3" r="1.4" /></>);
export const IconSlab = make(<><rect x="6" y="2.8" width="12" height="18.4" rx="2.2" /><path d="M8.6 6.2h6.8" /><rect x="8.6" y="9" width="6.8" height="9" rx="1" /></>);
export const IconStack = make(<><rect x="4" y="7" width="12" height="14" rx="2" /><path d="M8 4.2h9.8c1.2 0 2.2 1 2.2 2.2V17" /></>);
export const IconBinder = make(<><rect x="3.5" y="4" width="17" height="16" rx="2.2" /><path d="M12 4v16" /><rect x="6" y="7" width="3.5" height="4.6" rx=".6" /><rect x="14.5" y="7" width="3.5" height="4.6" rx=".6" /><rect x="6" y="13.2" width="3.5" height="4.6" rx=".6" /><rect x="14.5" y="13.2" width="3.5" height="4.6" rx=".6" /></>);
export const IconStar = make(<path d="M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.5l-5.1 2.7 1-5.6-4.1-4 5.7-.8z" />);
export const IconStarFill = make(<path d="M12 3.2l2.7 5.4 6 .9-4.3 4.2 1 5.9L12 16.8l-5.4 2.8 1-5.9-4.3-4.2 6-.9z" />, true);
export const IconGear = make(<><circle cx="12" cy="12" r="3" /><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z" /></>);
export const IconSearch = make(<><circle cx="10.8" cy="10.8" r="6.3" /><path d="M15.6 15.6L20.5 20.5" /></>);
export const IconPlus = make(<path d="M12 5v14M5 12h14" />);
export const IconX = make(<path d="M6 6l12 12M18 6L6 18" />);
export const IconChevron = make(<path d="M9.5 5.5L16 12l-6.5 6.5" />);
export const IconBack = make(<path d="M14.5 5.5L8 12l6.5 6.5" />);
export const IconChevronDown = make(<path d="M6 9.5l6 6 6-6" />);
export const IconArrowUp = make(<path d="M12 19V5M6 11l6-6 6 6" />);
export const IconExternal = make(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v4.5c0 .8-.7 1.5-1.5 1.5h-11c-.8 0-1.5-.7-1.5-1.5v-11C4 6.7 4.7 6 5.5 6H10" /></>);
export const IconRefresh = make(<><path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M4 12.5a8 8 0 0 0 13.7 5.2L20 15.5" /><path d="M20 20v-4.5h-4.5" /></>);
export const IconTrash = make(<><path d="M4.5 6.5h15" /><path d="M9.5 6.5V4.8c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1.7" /><path d="M6.5 6.5l.8 12.6c.1.9.8 1.6 1.7 1.6h6c.9 0 1.6-.7 1.7-1.6l.8-12.6" /></>);
export const IconDown = make(<><path d="M12 4v11" /><path d="M7 10.5l5 5 5-5" /><path d="M5 20h14" /></>);
export const IconPhone = make(<><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>);
export const IconInfo = make(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><path d="M12 7.6v.1" /></>);
export const IconSun = make(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></>);
export const IconMoon = make(<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />);
export const IconPencil = make(<><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>);

/** The Comps mark: a graded slab with a price line in the window. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect width="26" height="26" rx="6.5" fill="currentColor" />
      <rect x="8.3" y="4.4" width="9.4" height="17.2" rx="1.6" fill="none" stroke="var(--bg)" stroke-width="1.3" />
      <rect x="9.6" y="5.7" width="6.8" height="2" rx=".6" fill="var(--bg)" />
      <path d="M10.6 17.6l1.9-2.1 1.3 1 2-2.8" fill="none" stroke="var(--bg)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
