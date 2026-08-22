import type { ComponentProps, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { buttonClass, cn } from './styles';
import type { ButtonSize, ButtonVariant } from './styles';

// Replaces the hand-rolled button classes that had accumulated in 25 places.
//
// It renders whichever element the call site actually needs -- `to` gives a
// router Link, `href` a plain anchor, neither a <button> -- because roughly a
// third of the originals were links wearing button styling, and splitting that
// into two components would just recreate the duplication in a new shape.
//
// No `danger` variant yet: the app's destructive controls are outline-styled
// rather than solid fills, so adding one would either go unused or change how
// they look. It arrives with the status colours in 0009's identity branch.

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
};

type ButtonProps = CommonProps &
  Omit<ComponentProps<'button'>, 'className' | 'children'> & {
    to?: undefined;
    href?: undefined;
  };

type LinkProps = CommonProps &
  Omit<ComponentProps<typeof Link>, 'className' | 'children' | 'to'> & {
    to: string;
    href?: undefined;
  };

type AnchorProps = CommonProps &
  Omit<ComponentProps<'a'>, 'className' | 'children' | 'href'> & {
    href: string;
    to?: undefined;
  };

export default function Button(props: ButtonProps | LinkProps | AnchorProps) {
  const { variant = 'primary', size = 'md', className, children, ...rest } = props;
  const cls = buttonClass(variant, size, className);
  // Anchors are inline by default; buttons are not. Only the link renders need
  // blockifying, and only outside a flex container -- but it is cheap here and
  // keeps the class builder itself layout-neutral for migrated call sites.
  const linkCls = cn('inline-block', cls);

  if (rest.to !== undefined) {
    const { to, ...linkRest } = rest as LinkProps;
    return (
      <Link to={to} className={linkCls} {...linkRest}>
        {children}
      </Link>
    );
  }

  if (rest.href !== undefined) {
    const { href, ...anchorRest } = rest as AnchorProps;
    return (
      <a href={href} className={linkCls} {...anchorRest}>
        {children}
      </a>
    );
  }

  const { type = 'button', ...buttonRest } = rest as ButtonProps;
  return (
    <button type={type} className={cls} {...buttonRest}>
      {children}
    </button>
  );
}
