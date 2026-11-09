import LegalLayout, { Bullets, Section } from '../components/LegalLayout';
import { CONTACT_EMAIL, LOG_RETENTION_DAYS, OPERATOR, RECOVERY_DAYS, SERVICE_NAME } from '../lib/legal';

// Policy version 6 (1.0). Written from docs/POLICY-DRAFT-1.0.md, which carries
// the claims ledger tying each statement here to the code that makes it true,
// and the decisions Michael made on 9 Nov 2026 (Part F). Change a claim here
// and the ledger should change with it.
export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        <strong>The short version.</strong> {SERVICE_NAME} is a free scheduling tool for private
        Discord friend groups, run by one person as a hobby. It stores what it needs to schedule
        sessions and remind people about them, and nothing for advertising, analytics or sale. You
        can download everything it holds about you, or delete your account, from Settings at any
        time. The rest of this page is the detail, and it is meant to be complete: if something
        isn't listed here, {SERVICE_NAME} doesn't collect it. (The companies that host it also handle
        ordinary technical information about each request, such as your IP address, in order to
        deliver it — see "Who it is shared with".)
      </p>

      <Section heading="Who is responsible">
        <p>
          {SERVICE_NAME} is run by {OPERATOR}, who is responsible for the information described here
          (the "data controller", in data-protection terms). Contact:{' '}
          <strong>{CONTACT_EMAIL}</strong>.
        </p>
      </Section>

      <Section heading="What is collected, and why">
        <p>
          <strong>When you log in with Discord.</strong> {SERVICE_NAME} asks Discord only for the{' '}
          <code>identify</code> and <code>guilds</code> permissions. From those it keeps:
        </p>
        <Bullets
          items={[
            'Your Discord user ID, username, display name and avatar reference.',
            'Which of your Discord servers are on this app’s allow-list, when that was last checked, and — if you leave one — that you used to be in it. The rest of your server list is used once, to make that check, and never stored.',
          ]}
        />
        <p>
          It never asks for your email address, and it never sees your Discord messages or your
          password. The bot can list a server's voice channels, to offer one for an event, and checks
          from time to time that you are still a member of the servers you use here; it cannot read
          messages.
        </p>
        <p>
          <strong>What you create.</strong> Your timezone and settings; events (title, description,
          game, time, voice channel, and options such as a minimum number of attendees); polls and
          their candidate times; groups; invitations; your answers — RSVPs, poll votes, and the
          availability ranges you submit; requests to change an event (a proposed time or person to
          add, an optional message, and votes on them); and personal time blocks.
        </p>
        <p>
          <strong>Records {SERVICE_NAME} keeps to work properly.</strong>
        </p>
        <Bullets
          items={[
            <>
              <strong>Messages it has sent you.</strong> The text of each Discord direct message, when
              it was sent, and whether it was delivered — so that nothing is sent to you twice, and so
              that a message can be updated later (for example to show the answer you pressed). Also
              the ID of the direct-message channel between you and the bot, recorded the first time it
              messages you. This includes the one announcement sent when version 1.0 launched, which
              went only to people with notifications switched on.
            </>,
            <>
              <strong>Login sessions.</strong> When each was created, roughly when it was last used (to
              within a few minutes), when it expires, which version of this policy it was issued
              under, and whether it was revoked or replaced. Replaced sessions are kept until they
              would have expired anyway, which is how the service notices a copied session being
              reused.
            </>,
            <>
              <strong>Which version of this policy you agreed to, and when.</strong>
            </>,
            <>
              <strong>When you last logged in</strong>, and when a login was last refused (for example
              because you no longer share a server with the app).
            </>,
            <>
              <strong>Whether you've seen the 1.0 launch picture</strong> that appears once when you
              first open the app after the release, so it isn't shown to you again.
            </>,
          ]}
        />
        <p>
          <strong>Your IP address, briefly.</strong> The three places where signing in or connecting
          an account costs the service a request to Discord or Google are rate-limited, so a script
          can't hammer them. To count attempts, {SERVICE_NAME} turns your IP address into a scrambled
          code that can't be turned back into the address without a secret key only the service
          holds, and keeps that code with a count for the current minute. It is not linked to your
          account, and it is deleted within about fifteen minutes. Your IP address itself is never
          written to {SERVICE_NAME}'s database, and is never used for anything else.
        </p>
        <p>
          <strong>If you ask to add the bot to a server.</strong> That server's ID and name, your
          Discord user ID, and when the request was made and decided. The request repeats the Discord
          permission check above for that server, to confirm you administer it.
        </p>
        <p>
          <strong>If you connect a Google calendar.</strong> This is optional, off unless you choose
          it, and can be disconnected at any time. Connecting asks Google for permission to manage
          events (<code>calendar.events</code>) and to read your calendars (
          <code>calendar.readonly</code>). {SERVICE_NAME} then stores a long-lived Google credential,
          the email address of the Google account you connected, which calendar you chose, and a
          record of which sessions it has written there so nothing is written twice. The credential
          is <strong>encrypted before it is stored</strong>, with a key kept separately, and is never
          shown to anyone or included in "Download my data". Google will warn you when you connect
          that it hasn't verified {SERVICE_NAME}; that is expected for a project this small.
        </p>
        <p>
          <strong>What is written to your Google calendar</strong> is limited on purpose: only
          sessions you are committed to, with their title, times, the name of the Discord server and
          a link back here. <strong>Never descriptions</strong>, never a poll's proposed dates, never
          an event you've declined, and never your personal time.
        </p>
        <p>
          <strong>Reading a calendar is a separate choice, off by default.</strong> You can choose{' '}
          <em>one</em> of your Google calendars to be read, so people scheduling with you can see when
          you're busy. Every event on it is then copied into your own {SERVICE_NAME} calendar as
          read-only personal time, <strong>with its title, time and description</strong>, visible only
          to you; anyone else still sees only plain blocks of busy time. Events are read about two
          months ahead, at most forty at a time. Switching reading off, or choosing a different
          calendar, deletes every entry it created. Google's permission covers all your calendars,
          not just the one you choose — that only one is read is enforced by {SERVICE_NAME}'s own
          code, not by Google — so if that matters to you, leave reading off.
        </p>
        <p>
          <strong>Disconnecting</strong> removes the upcoming entries {SERVICE_NAME} wrote and asks
          Google to revoke its access. If Google can't confirm that at the time, the credential is
          still deleted here, but the permission may stay on your Google account until you remove it
          in your Google account's third-party access settings.{' '}
          <strong>
            Deleting your account revokes access too, but does not remove entries already written to
            your Google calendar
          </strong>{' '}
          — disconnect first if you want them gone.
        </p>
        <p>
          {SERVICE_NAME}'s use and transfer of information received from Google APIs adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="underline"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Section>

      <Section heading="What is deliberately not collected">
        <p>
          Your email address, your Discord messages, your Discord password or login tokens (used once
          during sign-in, in memory, then discarded), payment details, location, device fingerprints,
          advertising identifiers, or analytics of any kind. There are no third-party trackers, ad
          networks or tracking cookies.
        </p>
      </Section>

      <Section heading="What the site keeps in your browser">
        <Bullets
          items={[
            'Your sign-in, in your browser’s local storage, so you stay logged in, plus a marker of which account is signed in so that several tabs agree.',
            'A short-lived login check while you sign in, and a list of sign-outs waiting to be sent if you logged out while offline.',
            'Small preferences: the server you last selected, your calendar view, and the background scenery.',
            'Three cookies, each lasting ten minutes, set only while you sign in, ask to add the bot, or connect Google. They hold a one-time check value, are readable only by Uncle Owen’s server, and are not used for tracking.',
          ]}
        />
        <p>Nothing here is shared with anyone. Logging out removes your sign-in.</p>
      </Section>

      <Section heading="Who can see what">
        <p>Access is checked by the server on every request, not just hidden in the page.</p>
        <Bullets
          items={[
            <>
              <strong>An event's full details</strong>, including its description, are visible to its
              organizer and the people invited.
            </>,
            <>
              <strong>Your answers are visible to the other people invited</strong> to the same
              event: your RSVP, your poll votes with your name, and the availability ranges you
              submit.
            </>,
            <>
              <strong>The server noticeboard.</strong> Other members of a server can see a limited
              view of its events even if they weren't invited: the title, game, when it is, and who is
              invited with their answers. Never the description. An organizer can keep any event off
              the noticeboard; events created before the noticeboard existed were made private when
              it arrived, and stay off it unless their organizer later chooses to show them.
            </>,
            <>
              <strong>Change requests.</strong> If you ask to change an event, the organizer sees your
              request and its message. A request to move the time is also shown to the other invitees
              while it is open — with your name and your message — so they can vote on it; everyone
              sees the running total, and nobody sees who voted which way. Once it is decided, only
              you and the organizer can see it. A request to add someone is seen only by you and the
              organizer.
            </>,
            <>
              <strong>Groups.</strong> A group's members can see its name, game, owner and member
              list.
            </>,
            <>
              <strong>Personal time blocks</strong> are visible only to you.
            </>,
            <>
              <strong>Free/busy.</strong> Other members of a server you share can see when you are
              busy, as plain blocks of time with no title or detail. A block comes from an event you
              organize, an event you're invited to and haven't declined, a confirmed poll day you said
              yes to, or personal time marked "Busy" ("Considering" and "Free" never show). For a
              repeating event, a date you've declined can still show as busy. You can switch all of
              this off in Settings, and then they see nothing.
            </>,
            <>
              <strong>Your Discord profile</strong> (username, display name, avatar) is shown to other
              signed-in members of servers you share, so people can find who to invite, and to the
              other members of any group you are in, even after you stop sharing a server with them.
            </>,
            <>
              <strong>The operator</strong> has an admin page listing every account with its Discord
              ID, username, display name, whether notifications are on, when it last logged in and
              when a login was last refused, and which servers it belongs to or has left; and the
              requests to add the bot. There is no admin page showing anyone's events, answers or
              personal time. The operator can technically query the database directly, as with any
              service someone hosts: content is not end-to-end encrypted. The operator will only do so
              to fix a fault or where the law requires it.
            </>,
          ]}
        />
      </Section>

      <Section heading="Things the service does automatically">
        <p>So that nothing happens to your plans without you knowing it can:</p>
        <Bullets
          items={[
            'An organizer can set a minimum number of attendees, and either a deadline by which it must be met or none. If they switch on automatic cancellation, the event cancels itself — at the deadline, or as soon as someone’s “can’t make it” takes it below the minimum — and the service messages everyone still coming. Otherwise the organizer is messaged and decides.',
            'On a poll where each day is confirmed separately, a confirmed day becomes its own event, and your answer for that day — “I’m in”, “can’t make it” or “maybe” — carries over as your answer for it. If that day later falls below the number of people the poll needed, it is called off and the service messages everyone still coming.',
            'An account that hasn’t logged in for 365 days is deleted, exactly as if you’d pressed “Delete my account”. The service sends a Discord message two weeks and one week before. It is paused while you’re organizing, or invited to and haven’t declined, anything still to come — which includes any repeating event that hasn’t been cancelled, even one whose dates have all passed.',
          ]}
        />
        <p>
          Messages are sent through Discord, and the service retries a failed delivery, but it cannot
          guarantee you receive one: Discord may refuse it if you block the bot or don't accept
          messages from server members, and you may have turned notifications off.
        </p>
        <p>None of this involves profiling or decisions about you beyond these rules.</p>
      </Section>

      <Section heading="Who it is shared with">
        <p>
          Never sold, rented or shared for advertising. It is processed only by the services needed
          to run {SERVICE_NAME}:
        </p>
        <Bullets
          items={[
            <>
              <strong>Cloudflare</strong> runs the application and its database. Like any host, it
              receives your IP address with each request. It also keeps the application's own log
              lines for {LOG_RETENTION_DAYS} days, for finding faults. They can include Discord user and
              server IDs and error details; they don't include event titles, descriptions or message
              text, and Cloudflare's automatic record of every request is switched off.
            </>,
            <>
              <strong>GitHub</strong> serves the website's files. Like any web host, it receives your
              IP address when your browser loads the site.
            </>,
            <>
              <strong>Discord</strong> handles login and delivers the messages you get from the bot,
              including their text. Your browser also loads members' profile pictures directly from
              Discord's image servers, which — like any site serving an image — see your IP address
              when it does.
            </>,
            <>
              <strong>Resend</strong> delivers one kind of email, to the operator, when someone asks to
              add the bot to a server. It contains that person's Discord display name, username and
              ID, and the server's name and ID. Nothing else ever triggers an email.
            </>,
            <>
              <strong>Google</strong>, for people who connect a calendar, as described above. Google
              handles that information under its own privacy policy.
            </>,
          ]}
        />
        <p>
          The site's fonts are served from {SERVICE_NAME}'s own site, so visiting it does not contact
          Google or any font service. Profile pictures are the one exception to "everything comes
          from {SERVICE_NAME}'s own site", as described under Discord.
        </p>
        <p>
          Information may also be disclosed if the law requires it, or where you ask for it to be
          shared.
        </p>
      </Section>

      <Section heading="How long it is kept">
        <Bullets
          items={[
            <>
              <strong>Your account, settings, groups and personal time:</strong> until you delete
              your account, or after 365 days without logging in.
            </>,
            <>
              <strong>Events you organize, and everyone's answers on them:</strong> until you delete
              your account (past events are not removed on their own).
            </>,
            <>
              <strong>Cancelled events and finished polls:</strong> 90 days after they were last
              changed (normally the cancellation, or the poll closing).
            </>,
            <>
              <strong>Messages the bot sent you (text and delivery record):</strong> until the event
              or group they were about is removed, or your account is deleted. The two warnings
              before inactivity deletion, and the 1.0 launch announcement, stay until your account is
              deleted.
            </>,
            <>
              <strong>Login sessions:</strong> 7 days after they start, or sooner if you log out.
            </>,
            <>
              <strong>The scrambled code made from your IP address, for the login limit:</strong> at
              most about fifteen minutes; the address itself is never stored.
            </>,
            <>
              <strong>Sign-in cookies:</strong> 10 minutes.
            </>,
            <>
              <strong>Database recovery copies (Cloudflare D1 "Time Travel"):</strong>{' '}
              {RECOVERY_DAYS} days, after which deleted data can no longer be restored.
            </>,
            <>
              <strong>Cloudflare's copies of the application's log lines:</strong>{' '}
              {LOG_RETENTION_DAYS} days.
            </>,
          ]}
        />
      </Section>

      <Section heading="Your rights, and how to use them">
        <p>Everything below is available to everyone, in Settings, whatever the law where you live:</p>
        <Bullets
          items={[
            <>
              <strong>See and take your data:</strong> "Download my data" gives you a file with
              everything {SERVICE_NAME} holds about you, apart from the encrypted Google credential (if
              you connected Google), which is never given out to anyone.
            </>,
            <>
              <strong>Delete your account:</strong> "Delete my account" removes your profile,
              personal time, answers, invitations, group memberships, the messages logged as sent to
              you, your login sessions, and the events and groups you created, from {SERVICE_NAME}'s
              database, immediately.{' '}
              <strong>
                Events you organised disappear for everyone invited, with their answers, and no
                cancellation message is sent
              </strong>{' '}
              — tell people first if that matters. Cloudflare's recovery copies of the database still
              hold it for {RECOVERY_DAYS} days, after which it can no longer be restored. Discord
              messages already delivered stay in your Discord history, under Discord's own rules. If
              you had connected Google Calendar, entries already written there are not removed (see
              above).
            </>,
            <>
              <strong>Correct it:</strong> edit your events, groups and settings at any time.
            </>,
            <>
              <strong>Object or limit it:</strong> turn off Discord notifications, hide your
              free/busy time, or disconnect Google, in Settings. The warnings before an inactive
              account is deleted are still sent, because they exist to stop that deletion.
            </>,
          ]}
        />
        <p>
          If you can't sign in any more, email <strong>{CONTACT_EMAIL}</strong> and the same requests
          will be handled by hand, normally within a month. An email address doesn't prove who owns a
          Discord account, so you may be asked to confirm it is yours before anything is released or
          deleted. You may also have the right to complain to your data-protection authority. Using
          any of these rights never changes how the service treats you.
        </p>
      </Section>

      <Section heading="Why it is stored (legal bases)">
        <p>Where UK or EU data-protection law applies, the legal bases are:</p>
        <Bullets
          items={[
            <>
              <strong>Performance of a contract</strong> — storing your account, events, polls,
              groups, invitations, answers, change requests and personal time, connecting Google if you
              choose to, and sending the messages you've chosen to get, is the service you asked for
              by signing in.
            </>,
            <>
              <strong>Legitimate interests</strong> — keeping a record of messages sent so you aren't
              messaged twice; keeping replaced login sessions until they expire so a copied session can
              be detected; the login rate limit and its short-lived counts; checking that you still
              belong to the servers you use here; the warnings before an inactive account is deleted;
              telling people with notifications on that 1.0 had launched; and basic security and
              fault-finding, including the short-lived logs.
            </>,
            <>
              <strong>Legal obligation</strong> — where the law requires information to be disclosed.
            </>,
          ]}
        />
        <p>Discord notifications can be turned off at any time in Settings.</p>
      </Section>

      <Section heading="Security">
        <p>
          Traffic is encrypted (HTTPS); the database is encrypted at rest by Cloudflare; secrets are
          kept outside the code; sign-in sessions are short-lived, revocable, and replaced when they
          renew; Discord login tokens are never stored, and the Google credential is encrypted before
          it is stored. This is a hobby project run by one person, not a company with a security team
          — no system is perfectly secure, so please weigh that before putting anything sensitive in
          it.
        </p>
      </Section>

      <Section heading="Age">
        <p>
          {SERVICE_NAME} needs a Discord account and is not aimed at children. You must meet Discord's
          minimum age in your country (13 in most places, older in some).
        </p>
      </Section>

      <Section heading="Where it is processed">
        <p>
          Cloudflare, GitHub, Discord, Resend and Google process information in the United States and
          elsewhere, so it may be handled outside your country and, while there, be accessible to
          authorities under local law. Where information leaves the UK, the EU or Canada, these
          companies rely on their own published safeguards, such as the EU–US Data Privacy Framework
          or standard contractual clauses.
        </p>
      </Section>

      <Section heading="Changes to this policy">
        <p>
          When this policy changes in a way that matters, its version number goes up and the app asks
          everyone to read and agree to it before carrying on. Until you agree, the app shows only
          that request — though "Download my data" and "Delete my account" stay available, so you can
          leave instead. Small corrections that change nothing about your information update the date
          without asking again.
        </p>
      </Section>
    </LegalLayout>
  );
}
