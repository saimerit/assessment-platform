-- Insert Topics
INSERT INTO topics (id, name, description) VALUES
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Operating Systems', 'Core OS concepts'),
  ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Data Structures', 'Algorithms and collections')
ON CONFLICT DO NOTHING;

-- Insert Subcategories
INSERT INTO subcategories (id, topic_id, name) VALUES
  ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Concurrency & Deadlocks'),
  ('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Binary Trees')
ON CONFLICT DO NOTHING;

-- Insert Questions for Concurrency
INSERT INTO questions (id, subcategory_id, title, statement, difficulty, marks) VALUES
  ('11111111-0000-0000-0000-000000000001', 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'Deadlock Conditions', 'Which condition is NOT strictly required for a deadlock?', 'EASY', 2),
  ('11111111-0000-0000-0000-000000000002', 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'Bankers Algorithm', 'What state guarantees no deadlock can occur?', 'EASY', 2),
  ('11111111-0000-0000-0000-000000000003', 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'Race Conditions', 'What primitive solves race conditions without spinning?', 'EASY', 2);

-- Insert Questions for Trees
INSERT INTO questions (id, subcategory_id, title, statement, difficulty, marks) VALUES
  ('22222222-0000-0000-0000-000000000001', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'BST Search Complexity', 'Average time complexity to search an item in a balanced BST?', 'EASY', 2),
  ('22222222-0000-0000-0000-000000000002', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'Tree Traversal', 'Which traversal yields items in sorted order in a BST?', 'EASY', 2),
  ('22222222-0000-0000-0000-000000000003', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'AVL Tree Balance', 'What is the maximum allowed balance factor in an AVL tree?', 'EASY', 2);

-- Insert Blueprint & Rules (Blueprint asks for 2 OS Easy questions and 2 DS Easy questions)
INSERT INTO assessment_blueprints (id, title, duration_minutes) VALUES
  ('ffffffff-1111-2222-3333-444444444444', 'Midterm Technical Assessment', 60);

INSERT INTO blueprint_rules (blueprint_id, topic_id, difficulty, question_count, weightage_per_question) VALUES
  ('ffffffff-1111-2222-3333-444444444444', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'EASY', 2, 2),
  ('ffffffff-1111-2222-3333-444444444444', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'EASY', 2, 2);