import LegalLayout, { Bullets, Section } from '../components/LegalLayout';
import { CONTACT_EMAIL, OPERATOR, SERVICE_NAME } from '../lib/legal';

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        {SERVICE_NAME} is a small, non-commercial scheduling tool for private Discord friend groups.
        This policy explains exactly what it stores, why, who can see it, and how to get rid of it.
        It is deliberately specific rather than generic — if something isn't listed here, the service
        doesn't collect it.
      </p>

      <Section heading="Who is responsible">
        <p>
          {OPERATOR} is the data controller for the information described below. For any privacy
          question or request, contact <strong>{CONTACT_EMAIL}</strong>.
        </p>
      </Section>

      <Section heading="What is collected">
        <p>
          <strong>From Discord, when you log in.</strong> {SERVICE_NAME} uses Discord's OAuth2 with
          only the <code>identify</code> and <code>guilds</code> scopes, which provide:
        </p>
        <Bullets
          items={[
            'Your Discord user ID, username, display name, and avatar reference.',
            'The list of Discord servers you belong to — used only to check which of them are on this app’s allow-list. Servers that are not allow-listed are discarded immediately and never written to the database.',
          ]}
        />
        <p>
          <strong>What you create in the app.</strong> Your timezone, notification and availability
          preferences, events (titles, descriptions, games, times), groups you make, invitations,
          RSVPs, poll votes, submitted availability, and any personal time blocks you add.
        </p>
        <p>
          <strong>Operational records.</strong> The ID of the direct-message channel between you and
          the bot (so it isn't re-created on every notification), and a log of which notifications
          have already been sent to you, which exists solely to stop the service from messaging you
          twice about the same thing — including the two-week and one-week inactivity notices
          described under "How long it is kept" below. Also a record of your login sessions —
          creation time, last-used time, and expiry — which is what lets a session be revoked
          immediately (by you logging out, or by deleting your account) rather than staying valid
          until it naturally expires. Staying signed in periodically replaces the session behind the
          scenes, and the replaced one is kept, marked as replaced, until it would have expired
          anyway: that is what lets the service notice a replaced session being used again, which is
          a sign it was copied. Your data export shows both, so a single login that has been open a
          while appears as the session you are using plus the ones it replaced, rather than as
          several separate sign-ins.
        </p>
        <p>
          <strong>If you ask to add the bot to a server.</strong> The server's ID and name, your
          Discord user ID, and when the request was made and decided. Requesting also repeats the
          Discord permission check above for that specific server, to confirm you actually administer
          it — this uses the same <code>identify</code>/<code>guilds</code> scopes already described,
          at a separate moment from login, and is discarded the same way once the check is made.
        </p>
        <p>
          <strong>If you connect a Google calendar.</strong> This is entirely optional, off unless you
          switch it on, and can be disconnected at any time. Connecting asks Google for permission to
          manage events (<code>calendar.events</code>) and to read your calendar list and, if you
          nominate one, the events on it (<code>calendar.readonly</code>), and stores: a long-lived
          Google credential (a
          "refresh token"), the email address of the Google account you connected, which of your
          calendars you chose, and a record of which sessions have been written to it so the same
          entry isn't created twice.
        </p>
        <p>
          The credential is <strong>encrypted before it is written to the database</strong>, using a
          key held separately from the data, and it is never returned by any part of the app — not on
          screen, and not in "Download my data". Disconnecting, or deleting your account, deletes
          this service's copy and asks Google to revoke it. Google almost always confirms that
          immediately; if it does not — an outage, say — the credential is still deleted here, so
          this service can no longer use it, but the permission may survive on Google's side until
          you remove it yourself under your Google account's third-party access settings.
        </p>
        <p>
          <strong>What is written to your Google calendar</strong> is limited on purpose: the session
          title, its start and end times, the name of the Discord server it belongs to, and a link
          back to the event in this app. <strong>Event descriptions are never sent to Google.</strong>{' '}
          Only sessions you are actually committed to are written — never a poll's proposed dates,
          never an event you have declined, and never your personal time blocks.
        </p>
        <p>
          <strong>Reading a calendar is separate, and off unless you switch it on.</strong> You can
          additionally nominate <em>one</em> of your Google calendars to be read, so that people
          scheduling with you can see when you are already busy. Connecting for the writing above
          never starts this; it is a second choice, and it defaults to none.
        </p>
        <p>
          When it is on, every event on that one calendar is imported as a personal time entry on
          your own Uncle Owen calendar — with its real title, time and any description, exactly as it
          appears in Google, regardless of whether Google itself has that event marked "busy" or
          "free". These entries are <strong>read-only</strong>: they can only be changed by editing
          the source event in Google, which then updates here on the next sync — and they are all
          removed the moment you switch reading off, pick a different calendar, or disconnect. Two
          honest limits: entries are read about two months ahead, and if that window holds more than
          forty events only the earliest forty are imported, which Settings will tell you when it
          happens. Only you
          can see them, the same as any personal time block you create by hand — never anyone you
          share a server with, and never anyone scheduling with you.
        </p>
        <p>
          What anyone <em>else</em> ever sees from this is unchanged: opaque blocks of time, no
          titles, no attendees, no detail of any kind — the same opaque blocks described under
          "Free/busy availability" below. Turning off "Let people I share a server with see when I'm
          busy" hides them, as it hides everything else. Turning reading off entirely, or switching to
          a different calendar, deletes every entry it created immediately.
        </p>
        <p>
          <strong>An honest limitation worth stating plainly:</strong> Google's permissions are
          granted per account, not per calendar. There is no way to give this service access to one
          calendar alone, so the permission you grant technically covers all of them. That only one
          is ever read is enforced by this service's own code — it asks about the single calendar you
          picked and no others — rather than by a restriction Google imposes on it. If that
          distinction matters to you, the answer is to leave reading switched off, which is the
          default.
        </p>
      </Section>

      <Section heading="What is deliberately not collected">
        <Bullets
          items={[
            <>
              <strong>Your email address.</strong> The <code>email</code> scope is not requested, so
              Discord never provides it.
            </>,
            <>
              <strong>Your Discord messages.</strong> The bot has no message intents and does not read
              any channel or the content of any message you send. It DMs you directly, and can update
              those DMs afterward — for example, showing your RSVP once you press it. All it ever
              receives back is which button you pressed, never free text.
            </>,
            <>
              <strong>Discord access or refresh tokens.</strong> These are used once, in memory,
              during login to read your profile and server list, then discarded. They are not written
              to the database. (The optional Google calendar connection described above is the one
              exception to this pattern anywhere in the service, and only because a scheduled task
              has to write to your calendar at times when you are not logged in. It is stored
              encrypted, and only if you connect it.)
            </>,
            'Payment details, location data, device fingerprints, advertising identifiers, or analytics of any kind. There are no third-party trackers, cookies for tracking, or ad networks in this service.',
          ]}
        />
      </Section>

      <Section heading="Who can see your information">
        <p>
          Visibility inside the app is intentionally narrow, and enforced server-side on every
          request rather than merely hidden in the interface:
        </p>
        <Bullets
          items={[
            <>
              <strong>Events you were invited to.</strong> The full details of an event &mdash;
              including its description &mdash; are visible only to the organiser and the people
              invited to it.
            </>,
            <>
              <strong>The server noticeboard.</strong> Members of a server can see a{' '}
              <em>limited</em> view of events on that server even when they were not invited: the
              title, when it is, and who is invited along with their answer. Descriptions are never
              shown there, and neither is anything on a server you are not a member of.
              <span className="block pt-1">
                Two things about this are deliberate. An organiser can keep any event off the
                noticeboard when they create or edit it, and{' '}
                <strong>
                  every event created before this feature existed stays private permanently
                </strong>{' '}
                &mdash; nothing that was made under the previous policy changed visibility when this
                one took effect.
              </span>
            </>,
            <>
              <strong>Personal time blocks.</strong> Visible only to you. Nobody else can retrieve
              their name or description through any endpoint.
            </>,
            <>
              <strong>Free/busy availability.</strong> Other members of a server you share can see
              whether you are busy at a given time, as opaque blocks. They never receive the title,
              description, game, participants, or origin of whatever is occupying that time — the API
              returns only start and end timestamps. You can switch this off entirely in Settings, in
              which case others see nothing at all for you.
            </>,
            <>
              <strong>Your Discord profile.</strong> Your username, display name, and avatar are shown
              to other logged-in members of servers you share, so people can identify who they're
              inviting.
            </>,
            <>
              <strong>Requests to add the bot to a server.</strong> If you ask to add the bot
              somewhere, the operator sees your Discord display name, username and account id, and
              which server you asked for, since that's what they need to approve or reject the
              request.
            </>,
          ]}
        />
      </Section>

      <Section heading="Operator access (stated plainly)">
        <p>
          {SERVICE_NAME} runs on a database controlled by {OPERATOR}. The application's own rules
          prevent one user from reading another user's event details, and there is no administrative
          screen in the app for reading other people's data. However, whoever controls the hosting
          account can technically query the underlying database directly, as is true of any
          self-hosted service.
        </p>
        <p>
          This is stated explicitly rather than glossed over, because it is the honest limit of what
          the service can promise. Content is not end-to-end encrypted; if that guarantee matters to
          you for a particular plan, do not put it in this tool. The operator's commitment is not to
          access other users' event content except where strictly necessary to fix a fault or comply
          with law, and never for curiosity, profiling, or disclosure to anyone else.
        </p>
      </Section>

      <Section heading="Why it is stored (legal bases)">
        <p>
          Where UK/EU data protection law applies, the legal bases are: <strong>performance of a
          contract</strong> — storing your events, groups, and invitations is the service you asked
          for by signing in; and <strong>legitimate interests</strong> — keeping a minimal
          notification log so the bot doesn't message you repeatedly, and basic security and
          abuse-prevention. Discord notifications can be turned off at any time in Settings.
        </p>
      </Section>

      <Section heading="Who it is shared with">
        <p>
          Your information is never sold, licensed, rented, or shared with data brokers, advertising
          networks, or any monetisation service. It is processed only by the infrastructure needed to
          run the service:
        </p>
        <Bullets
          items={[
            <>
              <strong>Cloudflare</strong> — hosts the application server and database (encrypted at
              rest).
            </>,
            <>
              <strong>GitHub</strong> — serves the static website.
            </>,
            <>
              <strong>Discord</strong> — provides login and delivers the notification messages you
              have opted into.
            </>,
            <>
              <strong>Resend</strong> — sends the one email this service generates: telling the
              operator about a pending request to add the bot to a new server, including the
              requester's Discord display name, username and account id. Nothing else triggers an
              email, and this service does not
              otherwise hold or use your email address (see "What is deliberately not collected"
              above).
            </>,
            <>
              <strong>Google</strong> — <em>only if you connect a Google calendar</em>, which is off
              by default — the site's fonts are served from this app's own domain, precisely so that
              visiting it contacts Google not at all. Google then receives the session titles, times, server name, and app links
              described above, so that it can put them on the calendar you chose. Nothing is sent to
              Google for anyone who has not connected an account, and disconnecting stops it. Google
              processes that information under its own privacy policy and terms.
            </>,
          ]}
        />
        <p>
          Information may also be disclosed if required by law, or where you explicitly direct it to
          be shared.
        </p>
      </Section>

      <Section heading="How long it is kept">
        <p>
          Your information is retained while your account exists and for as long as it remains
          necessary to run the service, and is deleted promptly when you ask, when the service shuts
          down, or when it is no longer needed for the functionality described above.
        </p>
        <p>
          <strong>An account can also close itself.</strong> If you haven't logged in for close to a
          year, the service will try to DM you two weeks and then one week before it happens (if
          Discord will not accept a DM from the bot, the deletion still goes ahead), and the account —
          including everything listed on this page — is deleted the same way "Delete my account"
          would delete it. This is paused for as long as you're organizing, or invited and haven't
          declined, anything not yet in the past — deleting you shouldn't quietly change plans other
          people are relying on.
        </p>
      </Section>

      <Section heading="Your rights and how to use them">
        <p>Every one of these is available directly in the app, under Settings:</p>
        <Bullets
          items={[
            <>
              <strong>Access / portability.</strong> "Download my data" returns everything the service
              holds about you as a JSON file.
            </>,
            <>
              <strong>Erasure.</strong> "Delete my account" immediately and permanently removes your
              profile, personal time blocks, votes, invitations, group memberships, notification
              records, login sessions, and the events you organised. There is no soft-delete or grace
              period, and nothing is retained for analytics. The automatic year-of-inactivity deletion
              described above removes exactly the same things.
            </>,
            <>
              <strong>Rectification.</strong> Edit your events, groups, and preferences at any time.
            </>,
            <>
              <strong>Objection / restriction.</strong> Turn off Discord notifications, hide your
              free/busy availability, or disconnect a connected Google calendar — all in Settings.
              Disconnecting also removes the upcoming entries this service added to that calendar,
              and revokes its access with Google.
            </>,
          ]}
        />
        <p>
          If you can no longer sign in, email <strong>{CONTACT_EMAIL}</strong> from an address you
          control, or contact the operator via Discord, and the same requests will be handled
          manually. Depending on where you live you may also have the right to complain to a data
          protection authority, or (in California) to be free from discrimination for exercising
          these rights — this service does not treat anyone differently for doing so.
        </p>
      </Section>

      <Section heading="Security">
        <p>
          Traffic is served over HTTPS, the database is encrypted at rest by the hosting provider,
          credentials are held as secrets outside the source code, and session tokens are short-lived,
          revocable, and replaced with a new one each time they are renewed
          and signed. Long-lived Discord credentials are not stored at all. The one long-lived
          third-party credential that is stored — the Google calendar connection, only if you create
          one — is encrypted before it reaches the database, under a key kept separately from the
          service's other secrets, and it is never returned by any part of the app — not on screen,
          and not in "Download my data". (The scheduled sync must of course decrypt it to use it;
          what it is never allowed to do is hand it back to anyone.) No system is
          perfectly secure, and this is a hobby project run by one person rather than a company with
          a security team — please weigh that when deciding what to put in it.
        </p>
      </Section>

      <Section heading="Age">
        <p>
          {SERVICE_NAME} requires a Discord account and is not directed at children. Discord's own
          minimum age is 13, and higher in some countries; you must meet the minimum age in your
          country to use this service.
        </p>
      </Section>

      <Section heading="International transfers">
        <p>
          The infrastructure providers above operate in the United States, so information may be
          processed there regardless of where you live.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If this policy changes materially, the updated date at the top of this page will change and
          a notice will be shown in the app. Continuing to use {SERVICE_NAME} after a change means
          you accept it.
        </p>
      </Section>
    </LegalLayout>
  );
}
