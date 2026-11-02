-- Synthetic AOA accounts for the Trade Request read-parity cases (ticket). No real names or emails.
INSERT INTO app."User" (id, name, email, role) VALUES
  ('parity-admin',   'Ada Admin',     'ada.admin@example.test',     'ADMIN'),
  ('parity-ops',     'Orin Ops',      'orin.ops@example.test',      'OPERATIONS'),
  ('parity-avery',   'Avery Advisor', 'avery.advisor@example.test', 'ADVISOR'),
  ('parity-blake',   'Blake Advisor', 'blake.advisor@example.test', 'ADVISOR'),
  ('parity-nora',    'Abbigail New',      'nora.new@example.test',      'ADVISOR'),
  ('parity-viewer',  'Vic Viewer',    'vic.viewer@example.test',    'VIEWER'),
  ('parity-service', 'Cara Service',  'cara.service@example.test',  'CLIENT_SERVICE');
