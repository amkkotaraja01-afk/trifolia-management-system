
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(100) PRIMARY KEY,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(150) NOT NULL,
  role ENUM('Management','Office Staff','Guard','Resident','Tenant','Technical Team') NOT NULL,
  unit_no VARCHAR(50),
  parent_resident_id VARCHAR(100),
  contact VARCHAR(50),
  management_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  sinking_fund DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_due DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_role_unit(role, unit_no)
);

CREATE TABLE IF NOT EXISTS applications (
  id CHAR(36) PRIMARY KEY,
  applicant_name VARCHAR(150) NOT NULL,
  unit_no VARCHAR(50) NOT NULL,
  owner_tenant ENUM('Owner','Tenant') NOT NULL,
  contact VARCHAR(50),
  ic_passport VARCHAR(100),
  application_date DATE NOT NULL,
  scheduled_date DATE,
  application_type VARCHAR(100) NOT NULL,
  deposit_amount DECIMAL(12,2) NOT NULL,
  deposit_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
  deposit_method ENUM('Cash','Online') NULL,
  deposit_date DATE NULL,
  deposit_receipt_no VARCHAR(40) UNIQUE,
  deposit_received_by VARCHAR(150),
  deposit_issued_by_id VARCHAR(100),
  deposit_issued_by_name VARCHAR(150),
  total_refunded DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_forfeited DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('Awaiting Payment Receipt','Pending Approval','Approved','Rejected') NOT NULL,
  record_status ENUM('Open','Closed') NOT NULL DEFAULT 'Open',
  created_by VARCHAR(100) NOT NULL,
  created_for VARCHAR(100),
  approved_by VARCHAR(100),
  approved_by_name VARCHAR(150),
  approved_at DATETIME NULL,
  approval_note TEXT NULL,
  rejected_by VARCHAR(100),
  rejected_at DATETIME NULL,
  rejection_reason TEXT NULL,
  closed_by VARCHAR(100),
  closed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY(created_by) REFERENCES users(id),
  FOREIGN KEY(created_for) REFERENCES users(id),
  FOREIGN KEY(approved_by) REFERENCES users(id),
  FOREIGN KEY(rejected_by) REFERENCES users(id),
  FOREIGN KEY(closed_by) REFERENCES users(id),
  INDEX idx_app_date_status(application_date,status,record_status),
  INDEX idx_app_unit(unit_no)
);

CREATE TABLE IF NOT EXISTS payment_proofs (
  id CHAR(36) PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  data_url LONGTEXT NOT NULL,
  uploaded_by VARCHAR(100) NOT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(application_id) REFERENCES applications(id),
  FOREIGN KEY(uploaded_by) REFERENCES users(id),
  INDEX idx_proof_application(application_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id CHAR(36) PRIMARY KEY,
  transaction_date DATE NOT NULL,
  direction ENUM('IN','OUT') NOT NULL,
  method ENUM('Cash','Online','Cheque') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  receipt_no VARCHAR(40) UNIQUE,
  unit_no VARCHAR(50),
  application_id CHAR(36),
  type ENUM('DEPOSIT','REFUND','DEPOSIT_REFUND','MANAGEMENT_FEE','OVERNIGHT_PARKING','BANK_IN','ADJUSTMENT','MANUAL') NOT NULL,
  description VARCHAR(255) NOT NULL,
  issued_by_id VARCHAR(100) NOT NULL,
  issued_by_name VARCHAR(150) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(application_id) REFERENCES applications(id),
  FOREIGN KEY(issued_by_id) REFERENCES users(id),
  INDEX idx_tx_date_direction(transaction_date,direction),
  INDEX idx_tx_method(transaction_date,method),
  INDEX idx_tx_application(application_id)
);

CREATE TABLE IF NOT EXISTS refunds (
  id CHAR(36) PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  receipt_no VARCHAR(40) UNIQUE NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  refund_method ENUM('Cash','Online','Cheque') NULL,
  refund_date DATE NOT NULL,
  refund_time TIME NOT NULL,
  cheque_no VARCHAR(100),
  received_by VARCHAR(150),
  signature VARCHAR(255),
  issued_by_id VARCHAR(100) NOT NULL,
  issued_by_name VARCHAR(150) NOT NULL,
  outcome ENUM('FULL REFUND','PARTIAL REFUND','FORFEIT ALL') NOT NULL,
  description TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(application_id) REFERENCES applications(id),
  FOREIGN KEY(issued_by_id) REFERENCES users(id),
  INDEX idx_refund_application(application_id),
  INDEX idx_refund_date(refund_date)
);

CREATE TABLE IF NOT EXISTS daily_opening (
  business_date DATE PRIMARY KEY,
  opening_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  closed_at DATETIME NULL,
  closed_by VARCHAR(100),
  FOREIGN KEY(closed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) PRIMARY KEY,
  actor_id VARCHAR(100),
  action VARCHAR(100) NOT NULL,
  detail TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(actor_id) REFERENCES users(id),
  INDEX idx_audit_created(created_at)
);

-- User accounts are created through the secured application bootstrap, never seeded with shared default passwords.

CREATE OR REPLACE VIEW application_financial_summary AS
SELECT
  a.id,
  a.unit_no,
  a.applicant_name,
  a.application_type,
  a.record_status,
  a.status,
  a.deposit_paid,
  a.total_refunded,
  a.total_forfeited,
  GREATEST(0, a.deposit_paid - a.total_refunded - a.total_forfeited) AS deposit_balance,
  (SELECT COUNT(*) FROM refunds r WHERE r.application_id=a.id) AS refund_count
FROM applications a;

CREATE OR REPLACE VIEW daily_cash_report AS
SELECT
  t.transaction_date AS business_date,
  COALESCE((SELECT opening_cash FROM daily_opening d WHERE d.business_date=t.transaction_date),0) AS opening_cash,
  SUM(CASE WHEN t.direction='IN' AND t.method='Cash' THEN t.amount ELSE 0 END) AS cash_received,
  SUM(CASE WHEN t.direction='OUT' AND t.method='Cash' AND t.type<>'BANK_IN' THEN t.amount ELSE 0 END) AS cash_refund,
  SUM(CASE WHEN t.direction='OUT' AND t.method='Cash' AND t.type='BANK_IN' THEN t.amount ELSE 0 END) AS cash_bank_in,
  SUM(CASE WHEN t.direction='IN' AND t.method='Online' THEN t.amount ELSE 0 END) AS online_received,
  SUM(CASE WHEN t.direction='OUT' AND t.method='Online' THEN t.amount ELSE 0 END) AS online_refund,
  COALESCE((SELECT opening_cash FROM daily_opening d WHERE d.business_date=t.transaction_date),0)
    + SUM(CASE WHEN t.direction='IN' AND t.method='Cash' THEN t.amount ELSE 0 END)
    - SUM(CASE WHEN t.direction='OUT' AND t.method='Cash' THEN t.amount ELSE 0 END) AS closing_cash
FROM transactions t
GROUP BY t.transaction_date;

CREATE TABLE IF NOT EXISTS management_fee_payments (
  id CHAR(36) PRIMARY KEY,
  resident_id VARCHAR(100) NOT NULL,
  unit_no VARCHAR(50) NOT NULL,
  payment_month CHAR(7) NOT NULL,
  management_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  sinking_fund DECIMAL(12,2) NOT NULL DEFAULT 0,
  penalty DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('Cash','Online','Cheque') NOT NULL,
  payment_date DATE NOT NULL,
  status ENUM('Pending','Paid / Approved','Rejected') NOT NULL DEFAULT 'Pending',
  proof_file_name VARCHAR(255),
  proof_mime_type VARCHAR(100),
  proof_data LONGTEXT,
  submitted_by_id VARCHAR(100) NOT NULL,
  submitted_by_name VARCHAR(150) NOT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by_id VARCHAR(100),
  approved_by_name VARCHAR(150),
  approved_at DATETIME NULL,
  rejection_reason TEXT,
  receipt_no VARCHAR(40) UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY(resident_id) REFERENCES users(id),
  FOREIGN KEY(submitted_by_id) REFERENCES users(id),
  FOREIGN KEY(approved_by_id) REFERENCES users(id),
  INDEX idx_mf_unit_month(unit_no,payment_month),
  INDEX idx_mf_status(status),
  INDEX idx_mf_date(payment_date)
);

CREATE TABLE IF NOT EXISTS management_fee_penalty_waivers (
  id CHAR(36) PRIMARY KEY,
  resident_id VARCHAR(100) NOT NULL,
  unit_no VARCHAR(50) NOT NULL,
  payment_month CHAR(7) NOT NULL,
  waived_by_id VARCHAR(100) NOT NULL,
  waived_by_name VARCHAR(150) NOT NULL,
  reason TEXT,
  waived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mf_penalty_waiver(unit_no,payment_month),
  FOREIGN KEY(resident_id) REFERENCES users(id),
  FOREIGN KEY(waived_by_id) REFERENCES users(id)
);

CREATE OR REPLACE VIEW management_fee_unit_status AS
SELECT u.id AS resident_id, u.unit_no, u.name,
       u.management_fee, u.sinking_fund,
       (u.management_fee + u.sinking_fund) AS base_monthly_due
FROM users u WHERE u.role='Resident';

-- Shared application state bridge used by the React client.
-- This lets desktop, tablet and phone browsers read/write the same live data.
CREATE TABLE IF NOT EXISTS app_state (
  id TINYINT UNSIGNED PRIMARY KEY,
  state_json LONGTEXT NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- VISITOR OVERNIGHT PARKING MODULE
-- The React application also stores live shared state in app_state.
-- These tables provide a relational structure for the same workflow.
-- ============================================================
CREATE TABLE IF NOT EXISTS overnight_parking_lots (
  lot_id VARCHAR(30) PRIMARY KEY,
  lot_name VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO overnight_parking_lots(lot_id,lot_name,active)
SELECT CONCAT('V-',LPAD(n,2,'0')), CONCAT('Visitor Lot V-',LPAD(n,2,'0')), 1
FROM (
  SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
  UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10
  UNION ALL SELECT 11 UNION ALL SELECT 12 UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15
  UNION ALL SELECT 16 UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20
) x
ON DUPLICATE KEY UPDATE lot_id=VALUES(lot_id);

CREATE TABLE IF NOT EXISTS overnight_parking_applications (
  id CHAR(36) PRIMARY KEY,
  application_date DATE NOT NULL,
  resident_id VARCHAR(100) NOT NULL,
  resident_name VARCHAR(150) NOT NULL,
  unit_no VARCHAR(50) NOT NULL,
  owner_tenant ENUM('Owner','Tenant') NOT NULL,
  resident_contact VARCHAR(50),
  visitor_name VARCHAR(150) NOT NULL,
  visitor_contact VARCHAR(50) NOT NULL,
  car_type VARCHAR(100) NOT NULL,
  car_plate VARCHAR(30) NOT NULL,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  nights TINYINT NOT NULL,
  rate DECIMAL(10,2) NOT NULL DEFAULT 10.00,
  amount DECIMAL(10,2) NOT NULL,
  payer ENUM('Resident','Visitor') NOT NULL,
  payment_method ENUM('Cash','Online') NOT NULL,
  payment_status VARCHAR(80) NOT NULL DEFAULT 'Proof Uploaded - Awaiting Confirmation',
  status VARCHAR(60) NOT NULL DEFAULT 'Pending Review',
  record_status ENUM('Open','Closed') NOT NULL DEFAULT 'Open',
  lot_id VARCHAR(30),
  payment_receipt_no VARCHAR(50) UNIQUE,
  payment_confirmed_by VARCHAR(100),
  payment_confirmed_at DATETIME NULL,
  approved_by VARCHAR(100),
  approved_at DATETIME NULL,
  approval_note TEXT,
  rejected_by VARCHAR(100),
  rejected_at DATETIME NULL,
  rejection_reason TEXT,
  vehicle_status VARCHAR(30) DEFAULT 'Not entered',
  vehicle_entry_at DATETIME NULL,
  vehicle_exit_at DATETIME NULL,
  closed_by VARCHAR(100),
  closed_at DATETIME NULL,
  created_by VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY(resident_id) REFERENCES users(id),
  FOREIGN KEY(lot_id) REFERENCES overnight_parking_lots(lot_id),
  INDEX idx_overnight_dates(from_date,to_date),
  INDEX idx_overnight_unit(unit_no),
  INDEX idx_overnight_status(status,record_status),
  INDEX idx_overnight_lot(lot_id)
);

CREATE TABLE IF NOT EXISTS overnight_payment_proofs (
  id CHAR(36) PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  data_url LONGTEXT NOT NULL,
  uploaded_by VARCHAR(100) NOT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(application_id) REFERENCES overnight_parking_applications(id) ON DELETE CASCADE,
  FOREIGN KEY(uploaded_by) REFERENCES users(id),
  INDEX idx_overnight_proof_application(application_id)
);
-- ============================================================
-- OVERNIGHT PARKING BLACKLIST
-- ============================================================
CREATE TABLE IF NOT EXISTS overnight_blacklist (
  id CHAR(36) PRIMARY KEY,
  blacklist_type ENUM('IC','Car Plate','Person & Car') NOT NULL,
  ic_passport VARCHAR(100),
  car_plate VARCHAR(30),
  person_name VARCHAR(150),
  unit_no VARCHAR(50),
  reason TEXT NOT NULL,
  notes TEXT,
  active TINYINT(1) NOT NULL DEFAULT 1,
  registered_by VARCHAR(100) NOT NULL,
  registered_by_name VARCHAR(150) NOT NULL,
  registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_blacklist_ic(ic_passport),
  INDEX idx_blacklist_plate(car_plate),
  INDEX idx_blacklist_active(active),
  FOREIGN KEY(registered_by) REFERENCES users(id)
);

ALTER TABLE overnight_parking_applications
  ADD COLUMN IF NOT EXISTS resident_ic VARCHAR(100) NULL AFTER resident_contact,
  ADD COLUMN IF NOT EXISTS visitor_ic VARCHAR(100) NULL AFTER visitor_contact;


-- ============================================================
-- FINANCIAL CONTROL / DAILY CASH & ONLINE BANK MODULE
-- React shared-state remains the live cross-device source of truth.
-- These relational tables provide durable reporting/audit structure.
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_financial_days (
  business_date DATE PRIMARY KEY,
  opening_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  opening_online_bank DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_opening_mode VARCHAR(30) NOT NULL DEFAULT 'new',
  online_opening_mode VARCHAR(30) NOT NULL DEFAULT 'new',
  previous_closing_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  previous_closing_online_bank DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_opening_remark TEXT,
  online_opening_remark TEXT,
  opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_by VARCHAR(100),
  opened_by_name VARCHAR(150),
  INDEX idx_fin_opened_by(opened_by)
);

CREATE TABLE IF NOT EXISTS cash_bank_ins (
  id CHAR(36) PRIMARY KEY,
  business_date DATE NOT NULL,
  bank_in_time TIME NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  bank_name VARCHAR(150) NOT NULL,
  bank_account VARCHAR(100) NOT NULL,
  reference_no VARCHAR(100) NOT NULL,
  person_depositing VARCHAR(150) NOT NULL,
  remarks TEXT,
  prepared_by VARCHAR(100),
  prepared_by_name VARCHAR(150),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bank_in_date(business_date),
  INDEX idx_bank_in_reference(reference_no)
);

CREATE TABLE IF NOT EXISTS daily_financial_closings (
  id CHAR(36) PRIMARY KEY,
  business_date DATE NOT NULL UNIQUE,
  opening_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_received DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_refund DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_bank_in DECIMAL(12,2) NOT NULL DEFAULT 0,
  closing_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  actual_cash DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_difference DECIMAL(12,2) NOT NULL DEFAULT 0,
  opening_online_bank DECIMAL(12,2) NOT NULL DEFAULT 0,
  online_received DECIMAL(12,2) NOT NULL DEFAULT 0,
  online_refund DECIMAL(12,2) NOT NULL DEFAULT 0,
  closing_online_bank DECIMAL(12,2) NOT NULL DEFAULT 0,
  deposit_collected DECIMAL(12,2) NOT NULL DEFAULT 0,
  deposit_refunded DECIMAL(12,2) NOT NULL DEFAULT 0,
  remaining_deposit DECIMAL(12,2) NOT NULL DEFAULT 0,
  remark TEXT,
  closed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_by VARCHAR(100),
  closed_by_name VARCHAR(150),
  INDEX idx_closing_date(business_date)
);

CREATE TABLE IF NOT EXISTS financial_audit_trail (
  id CHAR(36) PRIMARY KEY,
  user_id VARCHAR(100),
  role VARCHAR(50),
  action VARCHAR(100) NOT NULL,
  previous_amount DECIMAL(12,2) NULL,
  new_amount DECIMAL(12,2) NULL,
  difference_amount DECIMAL(12,2) NULL,
  related_transaction_no VARCHAR(100),
  reason TEXT,
  detail TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fin_audit_created(created_at),
  INDEX idx_fin_audit_action(action)
);

-- ============================================================
-- TRIFOLIA RELATIONAL MODULES (v4)
-- These tables are the authoritative relational mirror for the
-- Property, Preventive Maintenance and Financial Accounting modules.
-- ============================================================

ALTER TABLE users MODIFY role ENUM('Management','Office Staff','Guard','Resident','Tenant','Technical Team') NOT NULL;
ALTER TABLE transactions MODIFY method ENUM('Cash','Online','Bank Transfer','Cheque') NOT NULL;
ALTER TABLE transactions MODIFY type ENUM('DEPOSIT','REFUND','DEPOSIT_REFUND','MANAGEMENT_FEE','OVERNIGHT_PARKING','BANK_IN','ADJUSTMENT','MANUAL','CASH_BOOK') NOT NULL;

CREATE TABLE IF NOT EXISTS property_tenancies (
  id CHAR(36) PRIMARY KEY,
  unit_no VARCHAR(50) NOT NULL,
  tenant_name VARCHAR(150) NOT NULL,
  ic_passport VARCHAR(100),
  contact VARCHAR(50),
  email VARCHAR(150),
  start_date DATE,
  end_date DATE,
  monthly_rent DECIMAL(12,2) NOT NULL DEFAULT 0,
  deposit DECIMAL(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'Active',
  remarks TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenancy_unit(unit_no), INDEX idx_tenancy_status(status)
);

CREATE TABLE IF NOT EXISTS property_ownerships (
  id CHAR(36) PRIMARY KEY,
  unit_no VARCHAR(50) NOT NULL,
  owner_name VARCHAR(150) NOT NULL,
  ic_passport VARCHAR(100),
  contact VARCHAR(50),
  email VARCHAR(150),
  ownership_type VARCHAR(30) NOT NULL DEFAULT 'Individual',
  share_percent DECIMAL(6,2) NOT NULL DEFAULT 100,
  purchase_date DATE,
  remarks TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ownership_unit(unit_no), INDEX idx_ownership_owner(owner_name)
);

CREATE TABLE IF NOT EXISTS property_transactions (
  id CHAR(36) PRIMARY KEY,
  transaction_date DATE NOT NULL,
  unit_no VARCHAR(50) NOT NULL,
  transaction_type VARCHAR(80) NOT NULL,
  reference_no VARCHAR(100),
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  party VARCHAR(150),
  status VARCHAR(40) NOT NULL DEFAULT 'Completed',
  remarks TEXT,
  processed_by VARCHAR(150),
  processed_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_property_tx_date(transaction_date), INDEX idx_property_tx_unit(unit_no)
);

CREATE TABLE IF NOT EXISTS maintenance_defects (
  id CHAR(36) PRIMARY KEY,
  report_date DATE NOT NULL,
  unit_no VARCHAR(50) NOT NULL,
  reported_by VARCHAR(150) NOT NULL,
  reporter_user_id VARCHAR(100),
  contact VARCHAR(50),
  category VARCHAR(80) NOT NULL,
  location VARCHAR(150),
  priority VARCHAR(20) NOT NULL DEFAULT 'Normal',
  assigned_to VARCHAR(150),
  status VARCHAR(40) NOT NULL DEFAULT 'Open',
  description TEXT NOT NULL,
  resolution TEXT,
  resolved_date DATE,
  remarks TEXT,
  resident_attachments LONGTEXT NULL,
  completion_attachments LONGTEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_defect_status(status), INDEX idx_defect_unit(unit_no), INDEX idx_defect_priority(priority), INDEX idx_defect_date(report_date)
);

CREATE TABLE IF NOT EXISTS registered_contractors (
  id CHAR(36) PRIMARY KEY,
  company_name VARCHAR(180) NOT NULL,
  registration_no VARCHAR(100),
  contact_person VARCHAR(150),
  phone VARCHAR(50),
  email VARCHAR(150),
  category VARCHAR(100),
  expiry_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'Active',
  remarks TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_contractor_status(status), INDEX idx_contractor_expiry(expiry_date)
);

CREATE TABLE IF NOT EXISTS cash_book_receipts (
  id CHAR(36) PRIMARY KEY,
  receipt_no VARCHAR(40) NOT NULL UNIQUE,
  receipt_date DATE NOT NULL,
  category ENUM('Maintenance Fee','Overnight Parking','Car & Motor Sticker','Lift Access Card','Car Access Card') NOT NULL,
  payer VARCHAR(150) NOT NULL,
  unit_no VARCHAR(50),
  amount DECIMAL(12,2) NOT NULL,
  payment_method ENUM('Cash','Online','Bank Transfer','Cheque') NOT NULL,
  reference_no VARCHAR(100),
  description TEXT,
  remarks TEXT,
  issued_by_id VARCHAR(100) NOT NULL,
  issued_by_name VARCHAR(150) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_cashbook_date(receipt_date), INDEX idx_cashbook_category(category), INDEX idx_cashbook_unit(unit_no),
  CONSTRAINT fk_cashbook_issuer FOREIGN KEY (issued_by_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS general_ledger_entries (
  id CHAR(36) PRIMARY KEY,
  transaction_date DATE NOT NULL,
  receipt_no VARCHAR(40),
  unit_no VARCHAR(50),
  direction ENUM('IN','OUT') NOT NULL,
  transaction_type VARCHAR(60) NOT NULL,
  description VARCHAR(255) NOT NULL,
  payment_method VARCHAR(30),
  amount DECIMAL(12,2) NOT NULL,
  source_id CHAR(36),
  issued_by_id VARCHAR(100),
  issued_by_name VARCHAR(150),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_gl_date(transaction_date), INDEX idx_gl_receipt(receipt_no), INDEX idx_gl_unit(unit_no), INDEX idx_gl_source(source_id)
);

CREATE TABLE IF NOT EXISTS audit_trail (
  id CHAR(36) PRIMARY KEY,
  event_time DATETIME NOT NULL,
  actor_id VARCHAR(100),
  actor_name VARCHAR(150),
  action VARCHAR(100) NOT NULL,
  detail TEXT,
  source_module VARCHAR(80),
  source_id CHAR(36),
  INDEX idx_audit_time(event_time), INDEX idx_audit_actor(actor_id), INDEX idx_audit_action(action)
);

-- V8 Preventive Maintenance extensions
CREATE TABLE IF NOT EXISTS technical_daily_jobs (
  id VARCHAR(64) PRIMARY KEY,
  job_date DATE NOT NULL,
  job_no VARCHAR(100) NULL,
  location VARCHAR(255) NOT NULL,
  job_type VARCHAR(100) NULL,
  description TEXT NOT NULL,
  assigned_to VARCHAR(255) NULL,
  status VARCHAR(50) NULL,
  start_time VARCHAR(10) NULL,
  end_time VARCHAR(10) NULL,
  findings TEXT NULL,
  action_taken TEXT NULL,
  remarks TEXT NULL,
  updated_by VARCHAR(100) NULL,
  updated_at DATETIME NULL,
  INDEX idx_technical_daily_date (job_date)
);
CREATE TABLE IF NOT EXISTS common_area_assets (
  id VARCHAR(64) PRIMARY KEY,
  asset_code VARCHAR(100) NULL,
  asset_name VARCHAR(255) NOT NULL,
  area VARCHAR(255) NOT NULL,
  asset_type VARCHAR(100) NULL,
  asset_condition VARCHAR(50) NULL,
  last_inspection DATE NULL,
  next_inspection DATE NULL,
  responsible VARCHAR(255) NULL,
  remarks TEXT NULL,
  updated_at DATETIME NULL
);
CREATE TABLE IF NOT EXISTS third_party_maintenance (
  id VARCHAR(64) PRIMARY KEY,
  service_date DATE NOT NULL,
  provider VARCHAR(255) NOT NULL,
  service_type VARCHAR(150) NOT NULL,
  reference_no VARCHAR(100) NULL,
  location VARCHAR(255) NULL,
  contact VARCHAR(255) NULL,
  status VARCHAR(50) NULL,
  next_date DATE NULL,
  description TEXT NULL,
  findings TEXT NULL,
  remarks TEXT NULL,
  updated_by VARCHAR(100) NULL,
  updated_at DATETIME NULL,
  INDEX idx_third_party_date (service_date)
);
CREATE TABLE IF NOT EXISTS deleted_records (
  id VARCHAR(64) PRIMARY KEY,
  source_table VARCHAR(100) NOT NULL,
  record_id VARCHAR(64) NOT NULL,
  label VARCHAR(255) NULL,
  deleted_at DATETIME NOT NULL,
  permanent_delete_after DATETIME NOT NULL,
  deleted_by VARCHAR(100) NULL,
  deleted_by_name VARCHAR(255) NULL,
  data_json LONGTEXT NOT NULL,
  INDEX idx_deleted_purge (permanent_delete_after)
);

CREATE TABLE IF NOT EXISTS visitor_registrations (
 id CHAR(36) PRIMARY KEY,
 pass_no VARCHAR(40) NOT NULL UNIQUE,
 resident_id VARCHAR(100) NULL,
 resident_name VARCHAR(150) NOT NULL,
 resident_contact VARCHAR(80) NULL,
 unit_no VARCHAR(50) NOT NULL,
 visitor_name VARCHAR(150) NOT NULL,
 visitor_contact VARCHAR(80) NOT NULL,
 visitor_ic VARCHAR(80) NULL,
 vehicle_type VARCHAR(40) NULL,
 car_plate VARCHAR(40) NULL,
 from_date DATE NOT NULL,
 to_date DATE NOT NULL,
 overnight TINYINT(1) NOT NULL DEFAULT 0,
 purpose VARCHAR(255) NULL,
 remarks TEXT NULL,
 qr_data VARCHAR(255) NOT NULL,
 qr_data_url LONGTEXT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'Active',
 created_by VARCHAR(100) NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX idx_vr_unit(unit_no), INDEX idx_vr_dates(from_date,to_date), INDEX idx_vr_visitor(visitor_name)
);

CREATE TABLE IF NOT EXISTS visitor_logs (
 id CHAR(36) PRIMARY KEY,
 registration_id CHAR(36) NOT NULL,
 pass_no VARCHAR(40) NOT NULL,
 unit_no VARCHAR(50) NOT NULL,
 resident_name VARCHAR(150) NULL,
 visitor_name VARCHAR(150) NOT NULL,
 action ENUM('IN','OUT') NOT NULL,
 method ENUM('QR','Manual') NOT NULL,
 at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 guard_id VARCHAR(100) NULL,
 guard_name VARCHAR(150) NULL,
 INDEX idx_vlog_registration(registration_id),
 INDEX idx_vlog_at(at),
 CONSTRAINT fk_vlog_registration FOREIGN KEY(registration_id) REFERENCES visitor_registrations(id) ON DELETE CASCADE
);
