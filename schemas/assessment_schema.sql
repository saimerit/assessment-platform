-- Enable UUID generation extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. TOPICS & TAXONOMY
CREATE TABLE topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT
);

CREATE TABLE subcategories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    UNIQUE(topic_id, name)
);

-- 2. QUESTION BANK
CREATE TABLE questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subcategory_id UUID NOT NULL REFERENCES subcategories(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    statement TEXT NOT NULL,
    question_type VARCHAR(30) NOT NULL DEFAULT 'MCQ', -- 'MCQ', 'CODING', 'SUBJECTIVE'
    difficulty VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',  -- 'EASY', 'MEDIUM', 'HARD'
    marks INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Options for MCQs
CREATE TABLE mcq_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL,
    is_correct BOOLEAN NOT NULL DEFAULT FALSE
);

-- 3. ASSESSMENT BLUEPRINTS (Rules for Generation)
CREATE TABLE assessment_blueprints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    duration_minutes INT NOT NULL DEFAULT 60,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Distribution criteria: how many questions from which topic/difficulty
CREATE TABLE blueprint_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blueprint_id UUID NOT NULL REFERENCES assessment_blueprints(id) ON DELETE CASCADE,
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    difficulty VARCHAR(20) NOT NULL,
    question_count INT NOT NULL CHECK (question_count > 0),
    weightage_per_question INT NOT NULL DEFAULT 1
);

-- 4. CANDIDATE EXAM ATTEMPTS & GENERATED INSTANCES
CREATE TABLE candidate_assessment_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blueprint_id UUID NOT NULL REFERENCES assessment_blueprints(id) ON DELETE CASCADE,
    student_id UUID NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'ASSIGNED', -- 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'EXPIRED'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(blueprint_id, student_id)
);

-- Stores the exact, ordered question paper generated specifically for each candidate
CREATE TABLE instance_questions (
    instance_id UUID NOT NULL REFERENCES candidate_assessment_instances(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    display_order INT NOT NULL,
    PRIMARY KEY(instance_id, question_id)
);

-- Stores candidate's live submitted answers
CREATE TABLE candidate_answers (
    instance_id UUID NOT NULL REFERENCES candidate_assessment_instances(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    selected_option_id UUID REFERENCES mcq_options(id),
    selected_option_ids UUID[],
    submitted_code TEXT,
    answered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY(instance_id, question_id)
);

-- Performance Indexes
CREATE INDEX idx_questions_subcat_diff ON questions(subcategory_id, difficulty);
CREATE INDEX idx_rules_blueprint ON blueprint_rules(blueprint_id);
