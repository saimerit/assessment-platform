\connect assessment_db
BEGIN;

CREATE TABLE IF NOT EXISTS attempt_paper_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id UUID UNIQUE REFERENCES candidate_sessions(id) ON DELETE CASCADE,
 invitation_id UUID UNIQUE REFERENCES assessment_invitations(id) ON DELETE CASCADE,
 org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 questions JSONB NOT NULL CHECK(jsonb_typeof(questions)='array'),
 grading_policy TEXT NOT NULL DEFAULT 'objective-v1',
 provenance TEXT NOT NULL CHECK(provenance IN ('PINNED_START','RECOVERED_CURRENT')),
 pinned_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(num_nonnulls(session_id,invitation_id)=1)
);
CREATE TABLE IF NOT EXISTS answer_vault.attempt_snapshot_keys (
 snapshot_id UUID NOT NULL REFERENCES attempt_paper_snapshots(id) ON DELETE CASCADE,
 question_id UUID NOT NULL,
 q_type VARCHAR(8) NOT NULL,
 expected_option_ids UUID[], expected_text TEXT, case_sensitive BOOLEAN NOT NULL,
 PRIMARY KEY(snapshot_id,question_id)
);

-- The application can pin a paper without acquiring SELECT on grading keys.
-- Ownership is checked inside the privileged function as well as at the API.
CREATE OR REPLACE FUNCTION pin_attempt_paper(p_kind TEXT,p_id UUID,p_org UUID,p_student UUID,p_source TEXT DEFAULT 'PINNED_START')
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result UUID; content JSONB; owner_org UUID; owner_student UUID; instance UUID;
BEGIN
 IF p_source NOT IN ('PINNED_START','RECOVERED_CURRENT') THEN RAISE EXCEPTION 'Invalid snapshot provenance'; END IF;
 IF p_kind='session' THEN
  SELECT e.org_id,cs.student_id INTO owner_org,owner_student FROM public.candidate_sessions cs JOIN public.assessment_events e ON e.id=cs.assessment_id WHERE cs.id=p_id;
 ELSE
  IF p_kind<>'legacy' THEN RAISE EXCEPTION 'Invalid attempt kind'; END IF;
  SELECT b.org_id,i.student_id,ai.id INTO owner_org,owner_student,instance FROM public.assessment_invitations i JOIN public.assessment_blueprints b ON b.id=i.blueprint_id
   JOIN public.candidate_assessment_instances ai ON ai.blueprint_id=i.blueprint_id AND ai.student_id=i.student_id WHERE i.id=p_id;
 END IF;
 IF owner_org IS NULL OR owner_org<>p_org OR owner_student<>p_student THEN RAISE EXCEPTION 'Snapshot ownership mismatch'; END IF;
 SELECT id INTO result FROM public.attempt_paper_snapshots WHERE (p_kind='session' AND session_id=p_id) OR (p_kind='legacy' AND invitation_id=p_id);
 IF result IS NOT NULL THEN RETURN result; END IF;
 -- Prevent a concurrent authoring commit from mixing old content with new keys.
 -- SHARE locks coexist across candidates and are held only through first-start commit.
 LOCK TABLE public.questions,public.mcq_options,answer_vault.secure_answer_keys IN SHARE MODE;
 WITH membership AS (
  SELECT pq.question_id,pq.sort_order AS position FROM public.candidate_sessions cs JOIN public.paper_questions pq ON pq.paper_id=cs.paper_id WHERE p_kind='session' AND cs.id=p_id
  UNION ALL SELECT iq.question_id,iq.display_order FROM public.instance_questions iq WHERE p_kind='legacy' AND iq.instance_id=instance
 ), data AS (
 SELECT q.id,m.position,jsonb_build_object('question_id',q.id,'display_order',m.position,'title',q.title,'statement',q.statement,'question_type',q.q_type,'marks',q.marks,
  'section_id',COALESCE(q.bank_id::text,''),'section_name',COALESCE(bank.name,'Assessment questions'),
  'options',CASE WHEN q.q_type='MCQ' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'text',o.option_text) ORDER BY o.display_order,o.id) FROM public.mcq_options o WHERE o.question_id=q.id),'[]'::jsonb) ELSE '[]'::jsonb END) AS item
 FROM membership m JOIN public.questions q ON q.id=m.question_id LEFT JOIN public.question_banks bank ON bank.id=q.bank_id
 LEFT JOIN public.subcategories sub ON sub.id=q.subcategory_id LEFT JOIN public.topics topic ON topic.id=sub.topic_id
 WHERE bank.org_id=p_org OR (q.bank_id IS NULL AND topic.org_id=p_org)
 ) SELECT COALESCE(jsonb_agg(item ORDER BY position),'[]'::jsonb) INTO content FROM data;
 IF jsonb_array_length(content)=0 THEN RAISE EXCEPTION 'Paper has no organization-owned questions'; END IF;
 IF jsonb_array_length(content)<>(CASE WHEN p_kind='session' THEN (SELECT count(*) FROM public.candidate_sessions cs JOIN public.paper_questions pq ON pq.paper_id=cs.paper_id WHERE cs.id=p_id)
 ELSE (SELECT count(*) FROM public.instance_questions WHERE instance_id=instance) END) THEN RAISE EXCEPTION 'Paper ownership mismatch'; END IF;
 INSERT INTO public.attempt_paper_snapshots(session_id,invitation_id,org_id,student_id,questions,provenance)
 VALUES(CASE WHEN p_kind='session' THEN p_id END,CASE WHEN p_kind='legacy' THEN p_id END,p_org,p_student,content,p_source) RETURNING id INTO result;
 INSERT INTO answer_vault.attempt_snapshot_keys(snapshot_id,question_id,q_type,expected_option_ids,expected_text,case_sensitive)
 SELECT result,k.question_id,k.q_type,COALESCE(k.expected_option_ids,array_remove(ARRAY[k.expected_option_id],NULL)),k.expected_text,k.case_sensitive
 FROM answer_vault.secure_answer_keys k JOIN jsonb_array_elements(content) q ON k.question_id=(q->>'question_id')::uuid AND k.q_type=q->>'question_type';
 IF (SELECT count(*) FROM answer_vault.attempt_snapshot_keys WHERE snapshot_id=result)<>jsonb_array_length(content) THEN RAISE EXCEPTION 'Paper grading keys are incomplete'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION pin_attempt_paper(TEXT,UUID,UUID,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pin_attempt_paper(TEXT,UUID,UUID,UUID,TEXT) TO assessment_app;
REVOKE ALL ON attempt_paper_snapshots FROM assessment_app;
GRANT SELECT ON attempt_paper_snapshots TO assessment_app,assessment_grader;
REVOKE ALL ON answer_vault.attempt_snapshot_keys FROM PUBLIC,assessment_app;
GRANT SELECT ON answer_vault.attempt_snapshot_keys TO assessment_grader;

CREATE TABLE IF NOT EXISTS attempt_submissions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version INT NOT NULL DEFAULT 1 CHECK(version=1),
 session_id UUID UNIQUE REFERENCES candidate_sessions(id) ON DELETE CASCADE,
 invitation_id UUID UNIQUE REFERENCES assessment_invitations(id) ON DELETE CASCADE,
 instance_id UUID UNIQUE REFERENCES candidate_assessment_instances(id) ON DELETE CASCADE,
 snapshot_id UUID NOT NULL REFERENCES attempt_paper_snapshots(id),
 org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, assessment_id UUID NOT NULL,
 checkpoint_revision BIGINT NOT NULL, answers JSONB NOT NULL,
 question_count INT NOT NULL, answered_count INT NOT NULL,
 deadline TIMESTAMPTZ NOT NULL, submitted_at TIMESTAMPTZ NOT NULL, finalized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 reason TEXT NOT NULL CHECK(reason IN ('MANUAL','DEADLINE','RECOVERED')),
 grading_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(grading_status IN ('PENDING','GRADED')), graded_at TIMESTAMPTZ,
 CHECK(num_nonnulls(session_id,invitation_id)=1),
 CHECK((session_id IS NOT NULL AND instance_id IS NULL) OR (invitation_id IS NOT NULL AND instance_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS submission_outbox (
 submission_id UUID PRIMARY KEY REFERENCES attempt_submissions(id) ON DELETE CASCADE,
 payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 attempts INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 delivered_at TIMESTAMPTZ, last_error TEXT
);
CREATE INDEX IF NOT EXISTS submission_outbox_pending ON submission_outbox(next_attempt_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS candidate_sessions_deadline ON candidate_sessions(timer_expires_at) WHERE started_at IS NOT NULL AND status='IN_PROGRESS';
CREATE INDEX IF NOT EXISTS candidate_instances_deadline ON candidate_assessment_instances(timer_expires_at) WHERE started_at IS NOT NULL AND status='IN_PROGRESS';
REVOKE ALL ON attempt_submissions FROM assessment_app,assessment_grader;
GRANT SELECT,INSERT ON attempt_submissions TO assessment_app;
GRANT SELECT ON attempt_submissions,submission_outbox TO assessment_grader;
GRANT UPDATE(grading_status,graded_at) ON attempt_submissions TO assessment_grader;
REVOKE ALL ON submission_outbox FROM assessment_app;
GRANT SELECT,INSERT,UPDATE ON submission_outbox TO assessment_app;

-- Legacy question references must remain available while pinned responses are saved.
DO $$ DECLARE name TEXT; BEGIN
 FOR name IN SELECT conname FROM pg_constraint WHERE conrelid='instance_questions'::regclass AND confrelid='questions'::regclass AND contype='f' LOOP
  EXECUTE format('ALTER TABLE instance_questions DROP CONSTRAINT %I',name);
 END LOOP;
 ALTER TABLE instance_questions ADD CONSTRAINT instance_questions_pinned_question_fkey FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE RESTRICT;
END $$;
COMMIT;
