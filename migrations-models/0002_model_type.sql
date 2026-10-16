-- The model's category (docs/models.md): prop, piece, character, creature, animation, scene, world.
ALTER TABLE models ADD COLUMN type TEXT;
