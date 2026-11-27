CREATE TABLE "b2_cloud" (
	"id" integer PRIMARY KEY AUTOINCREMENT,
	"user_id" text,
	"file_key" text NOT NULL UNIQUE,
	"WhoCanView" text,
	"likes" integer DEFAULT 0 NOT NULL,
	"date_posted" text NOT NULL,
	"video_cdn" text,
	"image_cdn" text,
	"b2_bucket" integer DEFAULT 1 NOT NULL,
	"video_url" text,
	"image_url" text,
	"video_blob_key" text,
	"image_blob_key" text,
	"file_size" integer,
	"status" text DEFAULT 'unknown' NOT NULL,
	"created_at" numeric,
	"image_blob_pathname" text,
	"image_blob_url" text
);

CREATE INDEX "idx_b2_cloud_date_posted" ON "b2_cloud" ("date_posted");
CREATE INDEX "idx_b2_cloud_user"        ON "b2_cloud" ("user_id");
CREATE INDEX "idx_b2_cloud_status"      ON "b2_cloud" ("status");

CREATE VIEW "all_failed" AS
SELECT *
FROM "b2_cloud"
WHERE "user_id" IS NULL
  AND "WhoCanView" = 'Everyone'
ORDER BY "likes" DESC;

CREATE VIEW "failed_for_b2" AS
SELECT *
FROM "b2_cloud"
WHERE "status" = 'fail';

CREATE VIEW "tiktok_posts_summary" AS
SELECT
	"date_posted",
	"likes",
	"image_cdn",
	"video_cdn",
	"status",
	"image_blob_pathname",
	"image_blob_url"
FROM "b2_cloud";

CREATE VIEW "download_links_view" AS
SELECT
	"file_key",
	"user_id",
	"video_url",
	"image_url",
	"file_size",
	"created_at",
	"likes",
	"date_posted",
	"b2_bucket"
FROM "b2_cloud"
WHERE "video_url" IS NOT NULL;


CREATE INDEX "idx_b2_cloud_video_blob_key" ON "b2_cloud" ("video_blob_key");
CREATE INDEX "idx_b2_cloud_image_blob_key" ON "b2_cloud" ("image_blob_key");
