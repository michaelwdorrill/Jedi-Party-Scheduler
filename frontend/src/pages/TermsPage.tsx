import LegalLayout, { Bullets, Section } from '../components/LegalLayout';
import { CONTACT_EMAIL, OPERATOR, SERVICE_NAME } from '../lib/legal';

// Terms version 6 (1.0), from docs/POLICY-DRAFT-1.0.md Part C with Michael's
// decisions of 9 Nov 2026 applied (operator named, Virginia law, Google live).
export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service">
      <p>
        <strong>What this is.</strong> {SERVICE_NAME} is a free, non-commercial scheduling tool for
        private Discord friend groups, run by {OPERATOR}. By signing in you agree to these terms and to
        the Privacy Policy. If you don't agree, don't use it.
      </p>

      <Section heading="What it does">
        <p>
          Members of allow-listed Discord servers can create events and polls, invite people
          individually or by group, answer and vote, ask an organizer to change an event, block out
          personal time, see when others are busy, connect a Google calendar if they choose, and get
          Discord messages about all of this — including buttons to answer from Discord. Anyone who
          already has an account here and administers another Discord server can ask for the bot to be
          added to it; the operator approves or declines each request.
        </p>
      </Section>

      <Section heading="Who can use it">
        <p>
          You need a Discord account in good standing, must meet Discord's minimum age for your
          country, and must belong to an allow-listed server. There is no public sign-up.
        </p>
      </Section>

      <Section heading="Using it fairly">
        <Bullets
          items={[
            'Follow the law, and Discord’s Terms of Service and Community Guidelines.',
            'Don’t use event titles, descriptions, messages, group names or anything else others will see to harass, threaten, impersonate or abuse anyone.',
            'Don’t try to get at other people’s information, get around access controls or rate limits, overload the service, or automate it in ways a person wouldn’t use it.',
            'Don’t use the notification system to send unwanted messages.',
            'You’re responsible for what you put in, including what the people you invite will see.',
          ]}
        />
      </Section>

      <Section heading="When you organize something">
        <p>
          Your choices affect other people. Cancelling, moving or editing an event changes it for
          everyone invited. If you set a minimum number of attendees with automatic cancellation, the
          service cancels the event for you when it falls below. Cancelling a poll doesn't cancel days
          that have already become their own events. Deleting your account removes the events you
          organized for everyone, without telling them.
        </p>
      </Section>

      <Section heading="Messages from the bot">
        <p>
          {SERVICE_NAME} sends Discord messages about invitations, upcoming sessions, polls, change
          requests, cancellations and inactive groups, and sent one announcement when version 1.0
          launched. You can turn them off in Settings, or block the bot in Discord. The warnings before
          an inactive account is deleted are sent regardless, because they exist to stop that
          deletion.
        </p>
      </Section>

      <Section heading="Your content">
        <p>
          You own what you create. You let the operator store and show it only as needed to run the
          service — for example, showing an event's title to the people you invited and putting it in
          their messages, showing its title, game, time and invitees on the server noticeboard to other
          members of that server unless you keep the event off it, and writing it to your own Google
          calendar if you connect one.
        </p>
      </Section>

      <Section heading="No guarantees">
        <p>
          This is a hobby project, free, with no promise of uptime, support, or that data will never
          be lost. It is provided <strong>"as is"</strong>, without warranties of any kind, including
          merchantability, fitness for a particular purpose and non-infringement. Don't rely on it as
          the only record of anything important.
        </p>
      </Section>

      <Section heading="Limits on liability">
        <p>
          As far as the law allows, the operator isn't liable for indirect, incidental, special,
          consequential or exemplary damages, or for lost data, profits or plans, from using or being
          unable to use the service. Nothing here limits liability that can't legally be limited.
        </p>
      </Section>

      <Section heading="Discord and Google">
        <p>
          {SERVICE_NAME} is independent and isn't made, endorsed or sponsored by Discord Inc. or
          Google LLC. "Discord" is a trademark of Discord Inc., and "Google" and "Google Calendar" are
          trademarks of Google LLC. Your use of Discord and Google is governed by their own terms.
        </p>
      </Section>

      <Section heading="Ending">
        <p>
          You can stop at any time and delete your account in Settings. An account unused for 365 days
          is deleted automatically after two warnings, as the Privacy Policy describes. The operator
          may suspend or remove anyone who breaks these terms or puts the service or its users at
          risk, remove a server from the allow-list, or shut the service down — with reasonable notice
          before a planned shutdown where practical.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          When these terms change in a way that matters, their version goes up and the app asks you to
          agree again before carrying on; until you do, you can still download your data or delete
          your account.
        </p>
      </Section>

      <Section heading="Governing law">
        <p>
          These terms are governed by the laws of the Commonwealth of Virginia, United States, except
          where the law where you live gives you protections that can't be set aside.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          <strong>{CONTACT_EMAIL}</strong>
        </p>
      </Section>
    </LegalLayout>
  );
}
