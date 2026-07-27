import LegalLayout, { Bullets, Section } from '../components/LegalLayout';
import { CONTACT_EMAIL, OPERATOR, SERVICE_NAME } from '../lib/legal';

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service">
      <p>
        {SERVICE_NAME} is a free, non-commercial scheduling tool for private Discord friend groups,
        run by {OPERATOR}. By signing in, you agree to these terms. If you don't, simply don't use
        it.
      </p>

      <Section heading="What the service does">
        <p>
          {SERVICE_NAME} lets members of specific, allow-listed Discord servers create gaming
          sessions, invite each other individually or by group, vote on candidate times, record
          personal time blocks, and receive Discord direct messages about invitations and upcoming
          sessions.
        </p>
      </Section>

      <Section heading="Who can use it">
        <p>
          You need a Discord account in good standing, and you must meet Discord's minimum age
          requirement for your country. Access is limited to members of Discord servers the operator
          has explicitly allow-listed; there is no public sign-up.
        </p>
      </Section>

      <Section heading="Your responsibilities">
        <Bullets
          items={[
            'Use the service lawfully, and follow Discord’s Terms of Service and Community Guidelines while doing so.',
            'Don’t use event titles, descriptions, or group names to harass, threaten, impersonate, or abuse anyone — other invitees see that text.',
            'Don’t attempt to access other users’ data, disrupt the service, or work around its access controls or rate limits.',
            'Don’t use the service to send unsolicited bulk messages through the notification system.',
            'You’re responsible for what you put into the service, including anything visible to people you invite.',
          ]}
        />
      </Section>

      <Section heading="Notifications">
        <p>
          The service sends Discord direct messages about invitations, upcoming sessions, poll
          deadlines, and inactive groups. You can turn these off at any time in Settings, and Discord
          itself lets you block the bot outright.
        </p>
      </Section>

      <Section heading="Your content">
        <p>
          You keep ownership of everything you create. You grant {OPERATOR} only the limited
          permission needed to store and display it in order to operate the service — for example,
          showing an event's title to the people you invited and including it in their notifications.
          Deleting your account removes it, as described in the Privacy Policy.
        </p>
      </Section>

      <Section heading="Availability, and no warranty">
        <p>
          This is a hobby project offered free of charge, with no uptime guarantee, no support
          commitment, and no promise that data will never be lost. It is provided{' '}
          <strong>"as is"</strong>, without warranties of any kind, express or implied, including
          merchantability, fitness for a particular purpose, and non-infringement. Do not rely on it
          as the sole record of anything that matters.
        </p>
      </Section>

      <Section heading="Limitation of liability">
        <p>
          To the fullest extent permitted by law, {OPERATOR} is not liable for any indirect,
          incidental, special, consequential, or exemplary damages, or for lost data, lost profits, or
          missed plans arising from the use of or inability to use the service. Nothing here limits
          liability that cannot legally be limited, and some jurisdictions do not allow certain
          exclusions, in which case they apply only to the extent permitted.
        </p>
      </Section>

      <Section heading="Relationship to Discord">
        <p>
          {SERVICE_NAME} is an independent application. It is not created by, affiliated with,
          endorsed by, or sponsored by Discord Inc. "Discord" is a trademark of Discord Inc. Your use
          of Discord itself remains governed by Discord's own terms and policies.
        </p>
      </Section>

      <Section heading="Suspension and termination">
        <p>
          You can stop using the service at any time and delete your account from Settings. The
          operator may suspend or remove access for anyone who breaks these terms, abuses other
          users, or puts the service at risk — and may remove a Discord server from the allow-list,
          or shut the service down entirely, at any time. Reasonable notice will be given before a
          planned shutdown where practical.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          These terms may change; the updated date at the top of this page will change with them, and
          material changes will be announced in the app. Continuing to use {SERVICE_NAME} after a
          change means you accept it.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions about these terms: <strong>{CONTACT_EMAIL}</strong>.
        </p>
      </Section>
    </LegalLayout>
  );
}
