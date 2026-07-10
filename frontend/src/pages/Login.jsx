import { useState } from 'react';
import { Button, Card, Center, PasswordInput, TextInput, Title, Alert } from '@mantine/core';
import { api, setUser } from '../api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api('/auth/login', { method: 'POST', body: { email, password } });
      setUser(data);
      window.location.href = '/';
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
          <TextInput label="Email" value={email} onChange={(e) => setEmail(e.target.value)} required mb="sm" />
          <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.target.value)} required mb="md" />
          <Button type="submit" fullWidth loading={loading}>Sign in</Button>
        </form>
      </Card>
    </Center>
  );
}
