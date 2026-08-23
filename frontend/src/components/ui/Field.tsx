import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';
import { cn, controlClass } from './styles';
import type { ControlSize } from './styles';

// Form controls. The bare input class appeared 29 times, always the same
// string, and never once with a focus style or a label association -- so this
// wires up `htmlFor`/`id` from a generated id rather than leaving it to each
// call site to remember.

/**
 * Label + control + optional hint/error. Pass a render function to receive the
 * generated id, or plain children when the control labels itself.
 */
export default function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode | ((props: { id: string; 'aria-describedby'?: string }) => ReactNode);
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-xs text-muted">
        {label}
      </label>
      {typeof children === 'function'
        ? children({ id, 'aria-describedby': describedBy })
        : children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type SizedInput = Omit<ComponentProps<'input'>, 'size'> & { size?: ControlSize; full?: boolean };

export function TextInput({ size = 'lg', full = true, className, ...rest }: SizedInput) {
  return <input className={controlClass(size, cn(full && 'w-full', className))} {...rest} />;
}

type SizedSelect = Omit<ComponentProps<'select'>, 'size'> & { size?: ControlSize; full?: boolean };

export function Select({ size = 'lg', full = true, className, ...rest }: SizedSelect) {
  return <select className={controlClass(size, cn(full && 'w-full', className))} {...rest} />;
}

type SizedTextarea = Omit<ComponentProps<'textarea'>, 'size'> & { size?: ControlSize; full?: boolean };

export function Textarea({ size = 'lg', full = true, className, ...rest }: SizedTextarea) {
  return <textarea className={controlClass(size, cn(full && 'w-full', className))} {...rest} />;
}
