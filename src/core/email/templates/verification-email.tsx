import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';

export interface VerificationEmailProps {
  /** Headline shown at the top of the message, e.g. "Confirm your registration". */
  heading: string;
  /** One sentence explaining why the message arrived. */
  intro: string;
  /** One-time code the recipient can type into the application. */
  otp: string;
  /** Absolute URL behind the call-to-action button. */
  actionUrl: string;
  /** Label of the call-to-action button, e.g. "Confirm registration". */
  actionLabel: string;
  /** Lifetime of both the code and the link, in minutes. */
  expiresInMinutes: number;
}

// Inline styles rather than a stylesheet: Gmail and Outlook strip <style>
// blocks, so anything not inlined is lost on the way to the inbox.
const body: React.CSSProperties = {
  backgroundColor: '#f4f4f5',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  margin: 0,
  padding: '24px 0',
};

const container: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e4e4e7',
  borderRadius: '8px',
  margin: '0 auto',
  maxWidth: '480px',
  padding: '32px',
};

const headingStyle: React.CSSProperties = {
  color: '#18181b',
  fontSize: '22px',
  fontWeight: 600,
  lineHeight: '28px',
  margin: '0 0 16px',
};

const paragraph: React.CSSProperties = {
  color: '#3f3f46',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '0 0 16px',
};

const codeSection: React.CSSProperties = {
  backgroundColor: '#f4f4f5',
  borderRadius: '6px',
  margin: '0 0 24px',
  padding: '16px',
  textAlign: 'center',
};

const code: React.CSSProperties = {
  color: '#18181b',
  fontFamily: "'Courier New', Courier, monospace",
  fontSize: '30px',
  fontWeight: 700,
  letterSpacing: '6px',
  lineHeight: '36px',
  margin: 0,
};

const button: React.CSSProperties = {
  backgroundColor: '#18181b',
  borderRadius: '6px',
  color: '#ffffff',
  display: 'block',
  fontSize: '15px',
  fontWeight: 600,
  padding: '12px 24px',
  textAlign: 'center',
  textDecoration: 'none',
};

const hr: React.CSSProperties = {
  borderColor: '#e4e4e7',
  margin: '24px 0',
};

const footer: React.CSSProperties = {
  color: '#71717a',
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0 0 8px',
};

const fallbackLink: React.CSSProperties = {
  color: '#3f3f46',
  fontSize: '13px',
  lineHeight: '20px',
  wordBreak: 'break-all',
};

export const VerificationEmail = ({
  heading,
  intro,
  otp,
  actionUrl,
  actionLabel,
  expiresInMinutes,
}: VerificationEmailProps) => (
  <Html lang="en">
    <Head />
    <Preview>{`${otp} — ${heading.toLowerCase()}`}</Preview>
    <Body style={body}>
      <Container style={container}>
        <Heading style={headingStyle}>{heading}</Heading>
        <Text style={paragraph}>{intro}</Text>

        <Section style={codeSection}>
          <Text style={code}>{otp}</Text>
        </Section>

        <Button href={actionUrl} style={button}>
          {actionLabel}
        </Button>

        <Hr style={hr} />

        <Text style={footer}>
          The code and the link expire in {expiresInMinutes} minutes. If the
          button does not work, paste this address into your browser:
        </Text>
        <Link href={actionUrl} style={fallbackLink}>
          {actionUrl}
        </Link>
        <Text style={{ ...footer, margin: '16px 0 0' }}>
          If you did not request this, you can safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
);

// Consumed by the `email dev` preview server (`npm run email:dev`).
VerificationEmail.PreviewProps = {
  heading: 'Confirm your registration',
  intro: 'Use the code below to finish creating your account.',
  otp: '123456',
  actionUrl: 'http://localhost:5174/register/confirm/link?token=preview-token',
  actionLabel: 'Confirm registration',
  expiresInMinutes: 10,
} satisfies VerificationEmailProps;

export default VerificationEmail;
