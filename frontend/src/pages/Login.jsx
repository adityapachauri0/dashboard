import { useState } from 'react';
import { Button, Card, Center, Code, Group, Image, PasswordInput, Text, TextInput, Title, Alert } from '@mantine/core';
import QRCode from 'qrcode';
import { setUser } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null); // { secret, otpauth_url } on first admin login
  const [qr, setQr] = useState(null);
  const [step, setStep] = useState('creds'); // 'creds' | 'totp'
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // raw fetch: api() treats any 401 as session-expiry, but here 401 can mean "code required"
  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, ...(code ? { code } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setUser(data);
        window.location.href = '/';
        return;
      }
      if (res.status === 401 && data.totp_required) {
        setStep('totp');
        if (data.totp_setup) {
          setSetup(data.totp_setup);
          setQr(await QRCode.toDataURL(data.totp_setup.otpauth_url));
        }
        if (data.error) setError(data.error);
        return;
      }
      setError(data.error || 'invalid credentials');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Center h="100vh" style={{ background: '#0f172a' }}>
      <Card w={380} p="lg" shadow="xl">
        <Title order={3} mb="md">PCP Affiliate Dashboard</Title>
        {error && <Alert color="red" mb="sm">{error}</Alert>}
        <form onSubmit={submit}>
          {step === 'creds' && (
            <>
              <TextInput label="Email" value={email} onChange={(e) => setEmail(e.target.value)} required mb="sm" />
              <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.target.value)} required mb="md" />
              <Button type="submit" fullWidth loading={loading}>Sign in</Button>
            </>
          )}
          {step === 'totp' && (
            <>
              {setup && (
                <>
                  <Text size="sm" mb="xs">Two-factor setup: scan this with Google Authenticator (or any TOTP app), then enter the 6-digit code.</Text>
                  {qr && <Group justify="center" mb="xs"><Image src={qr} w={168} h={168} /></Group>}
                  <Text size="xs" c="dimmed" mb="sm">Manual entry key: <Code>{setup.secret}</Code></Text>
                </>
              )}
              {!setup && <Text size="sm" mb="sm">Enter the 6-digit code from your authenticator app.</Text>}
              <TextInput label="Authentication code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                maxLength={6} required autoFocus inputMode="numeric" mb="md" />
              <Button type="submit" fullWidth loading={loading}>Verify</Button>
            </>
          )}
        </form>
      </Card>
    </Center>
  );
}
