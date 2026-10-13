-- The Rate Board now includes settled Tribunal refunds and counts provider-favoring
-- Tribunal outcomes as accepted work. Discard snapshots computed with old rules.
DELETE FROM rate_board_snapshots WHERE id = 1;
