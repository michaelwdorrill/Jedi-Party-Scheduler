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
          twice about the same thing.
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
              any channel. It only sends direct messages.
            </>,
            <>
              <strong>Discord access or refresh tokens.</strong> These are used once, in memory,
              during login to read your profile and server list, then discarded. They are not written
              to the database.
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
              <strong>Events.</strong> Only the organiser and the people invited to an event can see
              its details. Sharing a Discord server with someone does not let you see their events.
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
              records, and the events you organised. There is no soft-delete or grace period, and
              nothing is retained for analytics.
            </>,
            <>
              <strong>Rectification.</strong> Edit your events, groups, and preferences at any time.
            </>,
            <>
              <strong>Objection / restriction.</strong> Turn off Discord notifications, or hide your
              free/busy availability, in Settings.
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
          credentials are held as secrets outside the source code, and session tokens are short-lived
          and signed. Long-lived Discord credentials are not stored at all. No system is perfectly
          secure, and this is a hobby project run by one person rather than a company with a security
          team — please weigh that when deciding what to put in it.
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
