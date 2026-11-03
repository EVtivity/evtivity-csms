-- v0.1.49 site layout: where each station's card stands on the 2D board, in
-- board px, saved by the layout Save (both or none; none shows the computed
-- default slot). Independent of the station's 3D spot. Added after the
-- release file shipped in a prerelease, so it is its own file.
ALTER TABLE "station_layout_positions" ADD COLUMN IF NOT EXISTS "board_x" integer;
--> statement-breakpoint
ALTER TABLE "station_layout_positions" ADD COLUMN IF NOT EXISTS "board_y" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "station_layout_positions"
    ADD CONSTRAINT "station_layout_positions_board_check"
    CHECK (("board_x" IS NULL) = ("board_y" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
