import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { API_BASE_URL } from '../api/client';
import { buttonClass } from '../components/ui';

// The one surface in the app with no task to interrupt, and the one you see at
// most once a session -- so it is where the identity gets to be the whole page
// rather than a border around some work.
//
// On load the suns descend and fade in, the glow builds under them, the
// vaporators resolve out of the haze, and the sign-in block rises last. Once,
// never repeating. Everything's resting state is its finished state, so under
// reduced motion the composed scene is simply there.
export default function LoginPage() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;
  if (isAuthenticated) return <Navigate to="/" replace />;

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-end overflow-hidden bg-[linear-gradient(to_bottom,#2E1E36_0%,#4A2F3A_26%,#7A4A2C_56%,#A8632B_74%,#2A1D14_92%,#1A1410_100%)]">
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
      >
        <g className="uo-hero-suns">
          <circle cx="512" cy="430" r="66" fill="#F0A24A" opacity="0.95" />
          <circle cx="610" cy="464" r="31" fill="#FFD98F" opacity="0.9" />
        </g>
        <g className="uo-hero-vaps" fill="#1A1008" opacity="0.62">
          <rect x="104" y="352" width="6" height="200" />
          <ellipse cx="107" cy="347" rx="13" ry="16" />
          <rect x="168" y="396" width="4.5" height="156" />
          <ellipse cx="170" cy="392" rx="9.5" ry="12" />
          <rect x="694" y="380" width="5" height="172" />
          <ellipse cx="696" cy="375" rx="11" ry="14" />
        </g>
        <path
          d="M0 600 C 110 540, 250 562, 400 550 C 550 538, 660 566, 800 552 L800 600 Z"
          fill="#1A1008"
          opacity="0.68"
        />
        <path
          d="M0 600 C 150 576, 300 590, 470 580 C 640 570, 720 592, 800 584 L800 600 Z"
          fill="#120C08"
          opacity="0.85"
        />
      </svg>

      <div className="uo-hero-glow pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_46%_34%_at_64%_74%,rgba(255,186,94,.42),transparent_70%)]" />

      <div className="uo-hero-copy relative z-10 flex flex-col items-center gap-5 px-6 pb-24 text-center">
        <span className="flex items-center gap-3">
          <svg width="40" height="40" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8" cy="10" r="6" fill="#F2C879" />
            <circle cx="14.5" cy="13" r="3.2" fill="#FFE9BC" />
          </svg>
          <h1 className="text-4xl tracking-widest text-[#FFF3DE] drop-shadow-[0_2px_10px_rgba(0,0,0,.5)]">
            Uncle Owen
          </h1>
        </span>

        <p className="max-w-sm text-[#E0C9A8]">
          Log in with Discord to see the schedule for your servers and coordinate sessions with
          your friends.
        </p>

        <a href={`${API_BASE_URL}/auth/login`} className={buttonClass('primary', 'hero')}>
          Log in with Discord
        </a>

        <p className="text-xs text-[#9A8067]">
          By logging in you agree to the{' '}
          <Link to="/terms" className="underline hover:text-[#E0C9A8]">
            Terms
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="underline hover:text-[#E0C9A8]">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
