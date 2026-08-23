import type { ReactNode } from 'react';
import { cn } from './styles';

// Title on the left, actions on the right, wrapping sanely on narrow screens.
// Every page had rebuilt this flex row by hand.

export default function PageHeader({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children && <div className="flex gap-2">{children}</div>}
    </div>
  );
}
