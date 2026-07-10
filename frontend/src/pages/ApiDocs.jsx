import { Alert, Card, Code, CopyButton, Button, Group, Stack, Table, Text, Title } from '@mantine/core';
import { getUser } from '../api';

const BASE = window.location.origin;

const FIELDS = [
  ['name — or first_name + last_name', 'Yes', 'Applicant full name'],
  ['email or phone', 'Yes (at least one)', 'Contact details. UK phone in any format'],
  ['brand', 'No', 'Site the lead came from (defaults to your registered brand)'],
  ['replaces_ref', 'No', 'Ref of your signature-failed lead this one replaces (e.g. KB-2026-000123)'],
];

const CURL = `curl -X POST ${BASE}/api/v1/leads \\
  -H 'X-API-Key: YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "first_name": "John",
    "last_name": "Smith",
    "email": "john.smith@example.com",
    "phone": "07700 900123",
    "brand": "yourbrand.co.uk"
  }'`;

export default function ApiDocs() {
  const user = getUser();
  return (
    <>
      <Title order={3} mb="md">API docs</Title>
      <Stack maw={760}>
        <Card withBorder>
          <Title order={5} mb="xs">Submitting leads</Title>
          <Text size="sm" mb="sm">
            POST each lead as JSON to <Code>{BASE}/api/v1/leads</Code> with your API key in the{' '}
            <Code>X-API-Key</Code> header. {user.role === 'affiliate'
              ? 'Your key was provided when your account was set up — contact us if it needs rotating (keys are shown only once).'
              : 'Keys are issued per affiliate from the Affiliates page and shown only once.'}
          </Text>
          <Group justify="space-between" align="start" wrap="nowrap">
            <Code block style={{ flex: 1 }}>{CURL}</Code>
            <CopyButton value={CURL}>
              {({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>}
            </CopyButton>
          </Group>
        </Card>

        <Card withBorder>
          <Title order={5} mb="xs">Fields</Title>
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr><Table.Th>Field</Table.Th><Table.Th>Required</Table.Th><Table.Th>Notes</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {FIELDS.map(([f, r, n]) => (
                <Table.Tr key={f}><Table.Td><Code>{f}</Code></Table.Td><Table.Td>{r}</Table.Td><Table.Td>{n}</Table.Td></Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Text size="sm" c="dimmed" mt="xs">Any extra fields you send are kept on the lead's raw payload.</Text>
        </Card>

        <Card withBorder>
          <Title order={5} mb="xs">Responses</Title>
          <Table withTableBorder>
            <Table.Tbody>
              <Table.Tr><Table.Td><Code>201</Code></Table.Td><Table.Td><Code>{'{"ref":"KB-2026-000123","status":"pending"}'}</Code> — keep the ref; every later status update references it</Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Code>400</Code></Table.Td><Table.Td>Missing name / contact details, or <Code>replaces_ref</Code> not found</Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Code>401</Code></Table.Td><Table.Td>Bad or missing API key</Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Code>409</Code></Table.Td><Table.Td>The lead named in <Code>replaces_ref</Code> was already replaced</Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Code>429</Code></Table.Td><Table.Td>Rate limit — max 120 submissions per minute</Table.Td></Table.Tr>
            </Table.Tbody>
          </Table>
        </Card>

        <Card withBorder>
          <Title order={5} mb="xs">Good to know</Title>
          <Text size="sm" component="div">
            <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
              <li><b>Signature window:</b> accepted leads have 48 hours to pass the signature check. A failed signature means the lead needs a replacement — submit the new lead with <Code>replaces_ref</Code> so it links (and you're never billed twice).</li>
              <li><b>Duplicates:</b> a submission with the same phone or email as any lead from the last 30 days is accepted but flagged for review before payment.</li>
              <li><b>Payment:</b> virgin searches pay in full; already-searched leads pay an upfront portion with the balance on law-firm confirmation. Track everything on the Summary and Leads pages, or download a monthly statement from Export.</li>
            </ul>
          </Text>
        </Card>

        {user.role === 'admin' && (
          <Alert color="blue" title="Onboarding a new affiliate">
            Create the affiliate (with rate card) on the Affiliates page, copy the one-time API key, and send them this page's contents plus their key. Smoke-test with one curl submission and check it appears in Leads.
          </Alert>
        )}
      </Stack>
    </>
  );
}
