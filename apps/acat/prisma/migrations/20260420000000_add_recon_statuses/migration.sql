-- Add recon outcome values to AcatStatus enum
ALTER TYPE "AcatStatus" ADD VALUE IF NOT EXISTS 'Matched';
ALTER TYPE "AcatStatus" ADD VALUE IF NOT EXISTS 'Mismatch';
ALTER TYPE "AcatStatus" ADD VALUE IF NOT EXISTS 'Pending';
