-- Fingerprint of the original file, so sharing the same photo twice doesn't add it twice.
ALTER TABLE photos ADD COLUMN source_hash TEXT;
CREATE INDEX photos_source_hash ON photos (source_hash);
