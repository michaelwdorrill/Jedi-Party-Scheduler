-- Lets a group carry a default game (e.g. "the Stellaris crew"), which the
-- event form can pre-fill when that group is invited.
ALTER TABLE groups ADD COLUMN game TEXT;
