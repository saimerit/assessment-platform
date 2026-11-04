-- Preserve the existing single-option columns for older clients while adding
-- arrays for multi-select questions and fractional grading.
ALTER TABLE answer_vault.secure_answer_keys
    ADD COLUMN IF NOT EXISTS expected_option_ids UUID[];

UPDATE answer_vault.secure_answer_keys
SET expected_option_ids = ARRAY[expected_option_id]
WHERE q_type = 'MCQ'
  AND expected_option_ids IS NULL
  AND expected_option_id IS NOT NULL;

ALTER TABLE candidate_answers
    ADD COLUMN IF NOT EXISTS selected_option_ids UUID[];

UPDATE candidate_answers
SET selected_option_ids = ARRAY[selected_option_id]
WHERE selected_option_ids IS NULL
  AND selected_option_id IS NOT NULL;

ALTER TABLE candidate_session_answers
    ADD COLUMN IF NOT EXISTS selected_option_ids UUID[];

UPDATE candidate_session_answers
SET selected_option_ids = ARRAY[selected_option_id]
WHERE selected_option_ids IS NULL
  AND selected_option_id IS NOT NULL;

ALTER TABLE candidate_results
    ALTER COLUMN total_score TYPE NUMERIC(10,2) USING total_score::NUMERIC(10,2),
    ALTER COLUMN max_score TYPE NUMERIC(10,2) USING max_score::NUMERIC(10,2);

ALTER TABLE candidate_session_results
    ALTER COLUMN score_obtained TYPE NUMERIC(10,2) USING score_obtained::NUMERIC(10,2),
    ALTER COLUMN max_score TYPE NUMERIC(10,2) USING max_score::NUMERIC(10,2);
