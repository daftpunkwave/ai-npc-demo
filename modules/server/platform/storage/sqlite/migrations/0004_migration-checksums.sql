-- 为已应用迁移增加校验和，并固定校验和功能上线前三个迁移的已发布内容指纹。
ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT '';

UPDATE schema_migrations
SET checksum = '094af55f72d0e55734d543297bdc094f73167714b6ba0b37202a067706cd5529'
WHERE version = 1;

UPDATE schema_migrations
SET checksum = '0952dd9b3492bd09bdbd345393bdc2b8576d26affbfa3b52fd62090963f9487e'
WHERE version = 2;

UPDATE schema_migrations
SET checksum = '69297c06204b3a8fa24a7573fe2fc086b54bc59b19e27157a45fadb6711c0932'
WHERE version = 3;
