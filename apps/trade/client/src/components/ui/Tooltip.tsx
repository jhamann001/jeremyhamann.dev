import { useId, type ReactNode } from 'react';

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

const positionStyles: Record<string, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
};

export function Tooltip({ content, children, position = 'top', className = '' }: TooltipProps) {
  const id = useId();

  if (!content) return <>{children}</>;

  return (
    <div className={`relative group/tooltip inline-flex ${className}`} tabIndex={0} aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className={`absolute ${positionStyles[position]} z-[100] px-2.5 py-1.5 text-[11px] leading-snug font-medium text-white bg-[var(--bg-pill)] rounded-lg shadow-lg w-max max-w-[220px] text-center pointer-events-none opacity-0 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 transition-opacity duration-150 delay-0 group-hover/tooltip:delay-300 group-focus-within/tooltip:delay-300`}
      >
        {content}
      </span>
    </div>
  );
}
