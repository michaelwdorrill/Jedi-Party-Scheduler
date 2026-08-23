import type { ReactNode } from 'react';
import { cardClass } from './styles';
import type { CardPadding } from './styles';

// The `rounded-lg border border-edge bg-surface p-4` box, which existed
// in 17 slightly-different copies. `padding` is a prop rather than a className
// override because p-3 vs p-4 was the only axis any of them actually varied on.

export default function Card({
  title,
  actions,
  padding = 'md',
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  padding?: CardPadding;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cardClass(padding, className)}
    >
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
