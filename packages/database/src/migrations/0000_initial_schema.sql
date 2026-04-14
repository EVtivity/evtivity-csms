CREATE TYPE "public"."charging_station_status" AS ENUM('available', 'unavailable', 'faulted');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('available', 'occupied', 'reserved', 'unavailable', 'faulted', 'charging', 'preparing', 'suspended_ev', 'suspended_evse', 'finishing', 'idle', 'discharging', 'ev_connected');--> statement-breakpoint
CREATE TYPE "public"."load_allocation_strategy" AS ENUM('equal_share', 'priority_based');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('pending', 'accepted', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."guest_session_status" AS ENUM('pending_payment', 'payment_authorized', 'charging', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'completed', 'invalid', 'faulted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transaction_event_type" AS ENUM('started', 'updated', 'ended');--> statement-breakpoint
CREATE TYPE "public"."certificate_status" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."csr_status" AS ENUM('pending', 'submitted', 'signed', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."worker_job_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('scheduled', 'active', 'in_use', 'used', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'webhook', 'push', 'sms', 'log');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cronjob_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'pre_authorized', 'captured', 'partially_refunded', 'refunded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."display_message_format" AS ENUM('ASCII', 'HTML', 'URI', 'UTF8', 'QRCODE');--> statement-breakpoint
CREATE TYPE "public"."display_message_priority" AS ENUM('AlwaysFront', 'InFront', 'NormalCycle');--> statement-breakpoint
CREATE TYPE "public"."display_message_state" AS ENUM('Charging', 'Faulted', 'Idle', 'Unavailable', 'Suspended', 'Discharging');--> statement-breakpoint
CREATE TYPE "public"."display_message_status" AS ENUM('pending', 'accepted', 'rejected', 'cleared', 'expired');--> statement-breakpoint
CREATE TYPE "public"."excluded_downtime_reason" AS ENUM('utility_outage', 'vandalism', 'natural_disaster', 'scheduled_maintenance', 'vehicle_caused');--> statement-breakpoint
CREATE TYPE "public"."report_frequency" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pending', 'generating', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."support_case_category" AS ENUM('billing_dispute', 'charging_failure', 'connector_damage', 'account_issue', 'payment_problem', 'reservation_issue', 'general_inquiry');--> statement-breakpoint
CREATE TYPE "public"."support_case_message_sender" AS ENUM('driver', 'operator', 'system');--> statement-breakpoint
CREATE TYPE "public"."support_case_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."support_case_status" AS ENUM('open', 'in_progress', 'waiting_on_driver', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ocpi_cdr_push_status" AS ENUM('pending', 'sent', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ocpi_interface_role" AS ENUM('SENDER', 'RECEIVER');--> statement-breakpoint
CREATE TYPE "public"."ocpi_partner_status" AS ENUM('pending', 'connected', 'suspended', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."ocpi_sync_direction" AS ENUM('push', 'pull');--> statement-breakpoint
CREATE TYPE "public"."ocpi_sync_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ocpi_token_direction" AS ENUM('issued', 'received');--> statement-breakpoint
CREATE TYPE "public"."charging_profile_source" AS ENUM('csms_set', 'station_reported');--> statement-breakpoint
CREATE TYPE "public"."firmware_update_status" AS ENUM('Downloaded', 'DownloadFailed', 'Downloading', 'DownloadScheduled', 'DownloadPaused', 'Idle', 'InstallationFailed', 'Installing', 'Installed', 'InstallRescheduled', 'InstallVerificationFailed', 'InvalidSignature', 'SignatureVerified');--> statement-breakpoint
CREATE TYPE "public"."log_upload_status" AS ENUM('BadMessage', 'Idle', 'NotSupportedOperation', 'PermissionDenied', 'Uploaded', 'UploadFailure', 'UploadFailed', 'Uploading', 'AcceptedCanceled');--> statement-breakpoint
CREATE TYPE "public"."offline_command_status" AS ENUM('pending', 'sent', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."variable_monitor_status" AS ENUM('pending', 'active', 'cleared', 'error');--> statement-breakpoint
CREATE TYPE "public"."firmware_campaign_station_status" AS ENUM('pending', 'downloading', 'downloaded', 'installing', 'installed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."firmware_campaign_status" AS ENUM('draft', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."config_template_push_station_status" AS ENUM('pending', 'accepted', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."config_template_push_status" AS ENUM('active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."css_connector_type" AS ENUM('ac_type2', 'ac_type1', 'dc_ccs2', 'dc_ccs1', 'dc_chademo');--> statement-breakpoint
CREATE TYPE "public"."css_station_status" AS ENUM('disconnected', 'booting', 'available', 'charging', 'faulted', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."css_transaction_status" AS ENUM('active', 'completed', 'faulted');--> statement-breakpoint
CREATE TYPE "public"."charging_profile_push_station_status" AS ENUM('pending', 'accepted', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."charging_profile_push_status" AS ENUM('active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."octt_run_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."octt_test_status" AS ENUM('passed', 'failed', 'skipped', 'error');--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "charging_stations" (
	"id" text PRIMARY KEY NOT NULL,
	"station_id" varchar(255) NOT NULL,
	"site_id" text,
	"vendor_id" text,
	"model" varchar(255),
	"serial_number" varchar(255),
	"firmware_version" varchar(255),
	"iccid" varchar(20),
	"imsi" varchar(20),
	"availability" charging_station_status DEFAULT 'available' NOT NULL,
	"onboarding_status" "onboarding_status" DEFAULT 'pending' NOT NULL,
	"last_heartbeat" timestamp with time zone,
	"is_online" boolean DEFAULT false NOT NULL,
	"is_simulator" boolean DEFAULT false NOT NULL,
	"load_priority" integer DEFAULT 5 NOT NULL,
	"circuit_id" text,
	"security_profile" integer DEFAULT 1 NOT NULL,
	"ocpp_protocol" varchar(20),
	"basic_auth_password_hash" varchar(512),
	"metadata" jsonb,
	"latitude" varchar(20),
	"longitude" varchar(20),
	"reservations_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charging_stations_station_id_unique" UNIQUE("station_id")
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"evse_id" text NOT NULL,
	"connector_id" integer NOT NULL,
	"status" "connector_status" DEFAULT 'unavailable' NOT NULL,
	"connector_type" varchar(50),
	"max_power_kw" numeric,
	"max_current_amps" integer,
	"auto_created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evses" (
	"id" text PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" integer NOT NULL,
	"auto_created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_power_limits" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"max_power_kw" numeric NOT NULL,
	"safety_margin_kw" numeric DEFAULT '0' NOT NULL,
	"strategy" "load_allocation_strategy" DEFAULT 'equal_share' NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_power_limits_site_id_unique" UNIQUE("site_id")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"address" varchar(500),
	"city" varchar(255),
	"state" varchar(100),
	"postal_code" varchar(20),
	"country" varchar(100),
	"latitude" varchar(20),
	"longitude" varchar(20),
	"timezone" varchar(100) DEFAULT 'America/New_York' NOT NULL,
	"contact_name" varchar(255),
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"contact_is_public" boolean DEFAULT false NOT NULL,
	"hours_of_operation" text,
	"metadata" jsonb,
	"reservations_enabled" boolean DEFAULT true NOT NULL,
	"free_vend_enabled" boolean DEFAULT false NOT NULL,
	"free_vend_template_id_21" text,
	"free_vend_template_id_16" text,
	"carbon_region_code" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "station_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"s3_key" text NOT NULL,
	"s3_bucket" text NOT NULL,
	"caption" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_driver_visible" boolean DEFAULT false NOT NULL,
	"is_main_image" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_layout_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"station_id" text NOT NULL,
	"position_x" numeric DEFAULT '0' NOT NULL,
	"position_y" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_layout_positions_station_id_unique" UNIQUE("station_id")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_favorite_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"station_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"sms_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_driver_notification_prefs_driver" UNIQUE("driver_id")
);
--> statement-breakpoint
CREATE TABLE "driver_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text,
	"id_token" varchar(255) NOT NULL,
	"token_type" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"password_hash" varchar(255),
	"registration_source" varchar(20) DEFAULT 'admin' NOT NULL,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"timezone" varchar(50) DEFAULT 'America/New_York' NOT NULL,
	"theme_preference" varchar(10) DEFAULT 'light' NOT NULL,
	"distance_unit" varchar(10) DEFAULT 'miles' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_method" varchar(20),
	"totp_secret_enc" varchar(500),
	"is_active" boolean DEFAULT true NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"last_notification_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_drivers" (
	"id" serial PRIMARY KEY NOT NULL,
	"fleet_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"fleet_id" text NOT NULL,
	"station_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_ocpp_id" varchar(255) NOT NULL,
	"evse_id" integer NOT NULL,
	"charging_session_id" text,
	"stripe_payment_intent_id" varchar(255),
	"guest_email" varchar(255) NOT NULL,
	"pre_auth_amount_cents" integer,
	"status" "guest_session_status" DEFAULT 'pending_payment' NOT NULL,
	"session_token" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "vehicle_efficiency_lookup" (
	"id" serial PRIMARY KEY NOT NULL,
	"make" varchar(100) NOT NULL,
	"model" varchar(100) NOT NULL,
	"year" varchar(4),
	"efficiency_mi_per_kwh" numeric(5, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" text PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"make" varchar(100),
	"model" varchar(100),
	"year" varchar(4),
	"vin" varchar(17),
	"license_plate" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charging_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" text,
	"connector_id" text,
	"driver_id" text,
	"transaction_id" varchar(36) NOT NULL,
	"status" "session_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"meter_start" integer,
	"meter_stop" integer,
	"energy_delivered_wh" numeric,
	"stopped_reason" varchar(50),
	"is_roaming" boolean DEFAULT false NOT NULL,
	"remote_start_id" integer,
	"reservation_id" text,
	"current_cost_cents" integer,
	"final_cost_cents" integer,
	"currency" varchar(3),
	"tariff_id" text,
	"tariff_price_per_kwh" numeric,
	"tariff_price_per_minute" numeric,
	"tariff_price_per_session" numeric,
	"tariff_idle_fee_price_per_minute" numeric,
	"tariff_tax_rate" numeric,
	"idle_started_at" timestamp with time zone,
	"idle_minutes" numeric DEFAULT '0' NOT NULL,
	"last_update_notified_at" timestamp with time zone,
	"metadata" jsonb,
	"free_vend" boolean DEFAULT false NOT NULL,
	"co2_avoided_kg" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charging_sessions_transaction_id_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
CREATE TABLE "meter_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" text,
	"session_id" text,
	"timestamp" timestamp with time zone NOT NULL,
	"measurand" varchar(100),
	"phase" varchar(10),
	"location" varchar(20),
	"unit" varchar(20),
	"value" numeric NOT NULL,
	"context" varchar(50),
	"signed_data" jsonb,
	"source" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"event_type" "transaction_event_type" NOT NULL,
	"seq_no" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"trigger_reason" varchar(50) NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"number_of_phases_used" integer,
	"cable_max_current" integer,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"driver_id" text,
	"code_hash" varchar(255) NOT NULL,
	"method" varchar(20) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_challenges_exactly_one_actor" CHECK (("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"driver_id" text,
	"token_hash" varchar(255) NOT NULL,
	"type" varchar(20) DEFAULT 'session' NOT NULL,
	"name" varchar(255),
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"permissions" jsonb,
	"token_suffix" varchar(8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_exactly_one_actor" CHECK (("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(500),
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user_notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sms_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_notification_prefs_user" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"permission" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_site_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"driver_id" text,
	"token_hash" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tokens_exactly_one_actor" CHECK (("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"phone" varchar(50),
	"role_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_reset_password" boolean DEFAULT false NOT NULL,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"timezone" varchar(50) DEFAULT 'America/New_York' NOT NULL,
	"theme_preference" varchar(10) DEFAULT 'light' NOT NULL,
	"has_all_site_access" boolean DEFAULT false NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_method" varchar(20),
	"totp_secret_enc" varchar(500),
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "pricing_group_drivers" (
	"id" serial PRIMARY KEY NOT NULL,
	"pricing_group_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pricing_group_drivers_driver" UNIQUE("driver_id")
);
--> statement-breakpoint
CREATE TABLE "pricing_group_fleets" (
	"id" serial PRIMARY KEY NOT NULL,
	"pricing_group_id" text NOT NULL,
	"fleet_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pricing_group_fleets_fleet" UNIQUE("fleet_id")
);
--> statement-breakpoint
CREATE TABLE "pricing_group_sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"pricing_group_id" text NOT NULL,
	"site_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pricing_group_sites_site" UNIQUE("site_id")
);
--> statement-breakpoint
CREATE TABLE "pricing_group_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"pricing_group_id" text NOT NULL,
	"station_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pricing_group_stations_station" UNIQUE("station_id")
);
--> statement-breakpoint
CREATE TABLE "pricing_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(500),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_holidays" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pricing_holidays_date" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "session_tariff_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"tariff_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"energy_wh_start" numeric DEFAULT '0' NOT NULL,
	"energy_wh_end" numeric,
	"duration_minutes" numeric,
	"idle_minutes" numeric DEFAULT '0' NOT NULL,
	"cost_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tariffs" (
	"id" text PRIMARY KEY NOT NULL,
	"pricing_group_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"price_per_kwh" numeric,
	"price_per_minute" numeric,
	"price_per_session" numeric,
	"idle_fee_price_per_minute" numeric,
	"reservation_fee_per_minute" numeric,
	"tax_rate" numeric,
	"restrictions" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pki_ca_certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"certificate_type" varchar(50) NOT NULL,
	"certificate" text NOT NULL,
	"serial_number" varchar(255),
	"issuer" varchar(500),
	"subject" varchar(500),
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"hash_algorithm" varchar(10),
	"issuer_name_hash" varchar(128),
	"issuer_key_hash" varchar(128),
	"status" "certificate_status" DEFAULT 'active' NOT NULL,
	"source" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pki_csr_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text,
	"csr" text NOT NULL,
	"certificate_type" varchar(50) NOT NULL,
	"request_id" integer,
	"status" "csr_status" DEFAULT 'pending' NOT NULL,
	"signed_certificate_chain" text,
	"provider_reference" varchar(500),
	"error_message" text,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"certificate_type" varchar(50) NOT NULL,
	"certificate" text NOT NULL,
	"serial_number" varchar(255),
	"issuer" varchar(500),
	"subject" varchar(500),
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"hash_algorithm" varchar(10),
	"issuer_name_hash" varchar(128),
	"issuer_key_hash" varchar(128),
	"parent_ca_id" integer,
	"source" varchar(50),
	"status" "certificate_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text,
	"driver_id" text,
	"action" varchar(100) NOT NULL,
	"category" varchar(20) NOT NULL,
	"auth_type" varchar(20) DEFAULT 'anonymous',
	"api_key_name" varchar(255),
	"method" varchar(10),
	"path" varchar(500),
	"status_code" integer,
	"duration_ms" integer,
	"remote_address" varchar(45),
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"event" varchar(50) NOT NULL,
	"remote_address" varchar(45),
	"protocol" varchar(50),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocpp_message_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"message_type" integer NOT NULL,
	"message_id" varchar(36) NOT NULL,
	"action" varchar(100),
	"payload" jsonb,
	"error_code" varchar(50),
	"error_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocpp_server_health" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"connected_stations" integer DEFAULT 0 NOT NULL,
	"avg_ping_latency_ms" double precision DEFAULT 0 NOT NULL,
	"max_ping_latency_ms" double precision DEFAULT 0 NOT NULL,
	"ping_success_rate" double precision DEFAULT 100 NOT NULL,
	"total_pings_sent" integer DEFAULT 0 NOT NULL,
	"total_pongs_received" integer DEFAULT 0 NOT NULL,
	"server_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "port_status_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" integer NOT NULL,
	"connector_id" integer,
	"previous_status" varchar(20),
	"new_status" varchar(20) NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_job_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_name" varchar(255) NOT NULL,
	"queue" varchar(100) NOT NULL,
	"status" "worker_job_status" NOT NULL,
	"duration_ms" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"aggregate_type" varchar(100) NOT NULL,
	"aggregate_id" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" integer NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" text,
	"connector_id" text,
	"driver_id" text,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fleet_reservation_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"fleet_id" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"charging_profile_data" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_event_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_driver_event_settings_event_type" UNIQUE("event_type")
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"subject" varchar(500),
	"body_html" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_notification_templates" UNIQUE("event_type","channel","language")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"recipient" varchar(500) NOT NULL,
	"subject" varchar(500),
	"body" text NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"event_type" varchar(255),
	"sent_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocpp_event_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"channel" "notification_channel" DEFAULT 'email' NOT NULL,
	"recipient" varchar(500) DEFAULT '' NOT NULL,
	"template_html" text,
	"language" varchar(10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ocpp_event_settings_event_channel" UNIQUE("event_type","channel")
);
--> statement-breakpoint
CREATE TABLE "system_event_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_system_event_settings_event_type" UNIQUE("event_type")
);
--> statement-breakpoint
CREATE TABLE "cronjobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"schedule" varchar(100) NOT NULL,
	"status" "cronjob_status" DEFAULT 'pending' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"duration_ms" integer,
	"result" jsonb,
	"error" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_payment_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"stripe_customer_id" varchar(255) NOT NULL,
	"stripe_payment_method_id" varchar(255) NOT NULL,
	"card_brand" varchar(20),
	"card_last4" varchar(4),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text,
	"driver_id" text,
	"site_payment_config_id" integer,
	"stripe_payment_intent_id" varchar(255),
	"stripe_customer_id" varchar(255),
	"payment_source" varchar(20) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"pre_auth_amount_cents" integer,
	"captured_amount_cents" integer,
	"refunded_amount_cents" integer DEFAULT 0 NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"failure_reason" varchar(500),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_records_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "payment_records_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE "site_payment_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"stripe_connected_account_id" varchar(255),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"pre_auth_amount_cents" integer DEFAULT 5000 NOT NULL,
	"platform_fee_percent" numeric,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_payment_configs_site_id_unique" UNIQUE("site_id")
);
--> statement-breakpoint
CREATE TABLE "circuits" (
	"id" text PRIMARY KEY NOT NULL,
	"panel_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"breaker_rating_amps" integer NOT NULL,
	"max_continuous_kw" numeric NOT NULL,
	"phase_connections" varchar(10),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "load_allocation_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"site_limit_kw" numeric NOT NULL,
	"total_draw_kw" numeric NOT NULL,
	"available_kw" numeric NOT NULL,
	"strategy" varchar(50) NOT NULL,
	"allocations" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panels" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"parent_panel_id" text,
	"name" varchar(255) NOT NULL,
	"breaker_rating_amps" integer NOT NULL,
	"voltage_v" integer DEFAULT 240 NOT NULL,
	"phases" integer DEFAULT 1 NOT NULL,
	"max_continuous_kw" numeric NOT NULL,
	"safety_margin_kw" numeric DEFAULT '0' NOT NULL,
	"oversubscription_ratio" numeric DEFAULT '1.0' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_load_management" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"strategy" "load_allocation_strategy" DEFAULT 'equal_share' NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_load_management_site_id_unique" UNIQUE("site_id")
);
--> statement-breakpoint
CREATE TABLE "unmanaged_loads" (
	"id" serial PRIMARY KEY NOT NULL,
	"panel_id" text,
	"circuit_id" text,
	"name" varchar(255) NOT NULL,
	"estimated_draw_kw" numeric NOT NULL,
	"meter_device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "display_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"ocpp_message_id" integer NOT NULL,
	"priority" "display_message_priority" NOT NULL,
	"status" "display_message_status" DEFAULT 'pending' NOT NULL,
	"state" "display_message_state",
	"format" "display_message_format" NOT NULL,
	"language" varchar(8),
	"content" text NOT NULL,
	"start_date_time" timestamp with time zone,
	"end_date_time" timestamp with time zone,
	"transaction_id" varchar(36),
	"evse_id" integer,
	"message_extra" jsonb,
	"ocpp_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "display_messages_station_id_ocpp_message_id_unique" UNIQUE("station_id","ocpp_message_id")
);
--> statement-breakpoint
CREATE TABLE "nevi_excluded_downtime" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" integer NOT NULL,
	"reason" "excluded_downtime_reason" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"notes" varchar(1000),
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nevi_station_data" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"operator_name" varchar(255),
	"operator_address" varchar(500),
	"operator_phone" varchar(50),
	"operator_email" varchar(255),
	"installation_cost" numeric,
	"grid_connection_cost" numeric,
	"maintenance_cost_annual" numeric,
	"maintenance_cost_year" integer,
	"der_capacity_kw" numeric,
	"der_capacity_kwh" numeric,
	"der_type" varchar(100),
	"program_participation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_nevi_station_data_station" UNIQUE("station_id")
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"report_type" varchar(50) NOT NULL,
	"format" varchar(10) NOT NULL,
	"frequency" "report_frequency" NOT NULL,
	"day_of_week" integer,
	"day_of_month" integer,
	"filters" jsonb,
	"recipient_emails" jsonb,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"report_type" varchar(50) NOT NULL,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"format" varchar(10) NOT NULL,
	"filters" jsonb,
	"file_data" "bytea",
	"file_name" varchar(255),
	"file_size" integer,
	"generated_by_id" text,
	"error" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"session_id" text,
	"description" varchar(500) NOT NULL,
	"quantity" numeric DEFAULT '1' NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_number" varchar(50) NOT NULL,
	"driver_id" text,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "payment_reconciliation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"checked_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"discrepancy_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"discrepancies" jsonb,
	"errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_case_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"s3_key" varchar(1024) NOT NULL,
	"s3_bucket" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_case_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"sender_type" "support_case_message_sender" NOT NULL,
	"sender_id" text,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_case_reads" (
	"user_id" text NOT NULL,
	"case_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_reads_user_id_case_id_pk" PRIMARY KEY("user_id","case_id")
);
--> statement-breakpoint
CREATE TABLE "support_case_sessions" (
	"case_id" text NOT NULL,
	"session_id" text NOT NULL,
	CONSTRAINT "support_case_sessions_case_id_session_id_pk" PRIMARY KEY("case_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "support_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"case_number" varchar(20) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"status" "support_case_status" DEFAULT 'open' NOT NULL,
	"category" "support_case_category" NOT NULL,
	"priority" "support_case_priority" DEFAULT 'medium' NOT NULL,
	"driver_id" text,
	"station_id" text,
	"assigned_to" text,
	"created_by_driver" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_cases_case_number_unique" UNIQUE("case_number")
);
--> statement-breakpoint
CREATE TABLE "ocpi_cdrs" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"ocpi_cdr_id" varchar(36) NOT NULL,
	"charging_session_id" text,
	"total_energy" numeric(10, 4) NOT NULL,
	"total_cost" numeric(10, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"cdr_data" jsonb NOT NULL,
	"is_credit" boolean DEFAULT false NOT NULL,
	"push_status" "ocpi_cdr_push_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocpi_credentials_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text,
	"token_hash" text NOT NULL,
	"token_prefix" varchar(8) NOT NULL,
	"direction" "ocpi_token_direction" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"outbound_token_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocpi_external_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"party_id" varchar(3) NOT NULL,
	"location_id" varchar(36) NOT NULL,
	"name" varchar(255),
	"latitude" varchar(20),
	"longitude" varchar(20),
	"evse_count" varchar(10) DEFAULT '0' NOT NULL,
	"location_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocpi_external_locations_unique" UNIQUE("partner_id","country_code","party_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "ocpi_external_tariffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"party_id" varchar(3) NOT NULL,
	"tariff_id" varchar(36) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"tariff_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocpi_external_tariffs_unique" UNIQUE("partner_id","country_code","party_id","tariff_id")
);
--> statement-breakpoint
CREATE TABLE "ocpi_external_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"party_id" varchar(3) NOT NULL,
	"uid" varchar(36) NOT NULL,
	"token_type" varchar(20) NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"whitelist" varchar(20) DEFAULT 'ALLOWED' NOT NULL,
	"token_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocpi_external_tokens_unique" UNIQUE("country_code","party_id","uid")
);
--> statement-breakpoint
CREATE TABLE "ocpi_location_publish" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"publish_to_all" boolean DEFAULT true NOT NULL,
	"ocpi_location_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocpi_location_publish_site_id_unique" UNIQUE("site_id")
);
--> statement-breakpoint
CREATE TABLE "ocpi_location_publish_partners" (
	"location_publish_id" integer NOT NULL,
	"partner_id" text NOT NULL,
	CONSTRAINT "ocpi_location_publish_partners_unique" UNIQUE("location_publish_id","partner_id")
);
--> statement-breakpoint
CREATE TABLE "ocpi_partner_endpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"module" varchar(50) NOT NULL,
	"interface_role" "ocpi_interface_role" NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "ocpi_partner_endpoints_unique" UNIQUE("partner_id","module","interface_role")
);
--> statement-breakpoint
CREATE TABLE "ocpi_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"party_id" varchar(3) NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"our_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "ocpi_partner_status" DEFAULT 'pending' NOT NULL,
	"version" varchar(10),
	"version_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocpi_partners_country_party" UNIQUE("country_code","party_id")
);
--> statement-breakpoint
CREATE TABLE "ocpi_roaming_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"ocpi_session_id" varchar(36) NOT NULL,
	"charging_session_id" text,
	"token_uid" varchar(36) NOT NULL,
	"status" varchar(20) NOT NULL,
	"kwh" numeric(10, 4) DEFAULT '0' NOT NULL,
	"total_cost" numeric(10, 2),
	"currency" varchar(3),
	"session_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocpi_sync_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"module" varchar(50) NOT NULL,
	"direction" "ocpi_sync_direction" NOT NULL,
	"action" varchar(50) NOT NULL,
	"status" "ocpi_sync_status" NOT NULL,
	"objects_count" varchar(10) DEFAULT '0' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocpi_tariff_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"tariff_id" text NOT NULL,
	"partner_id" text,
	"ocpi_tariff_id" varchar(36) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"ocpi_tariff_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_local_auth_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"driver_token_id" text,
	"id_token" varchar(255) NOT NULL,
	"token_type" varchar(20) NOT NULL,
	"auth_status" varchar(20) DEFAULT 'Accepted' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_local_auth_entries_station_token" UNIQUE("station_id","id_token")
);
--> statement-breakpoint
CREATE TABLE "station_local_auth_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"local_version" integer DEFAULT 0 NOT NULL,
	"reported_version" integer,
	"last_sync_at" timestamp with time zone,
	"last_modified_at" timestamp with time zone,
	"last_version_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_local_auth_versions_station_id_unique" UNIQUE("station_id")
);
--> statement-breakpoint
CREATE TABLE "allowed_energy_transfer_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"transaction_id" text,
	"allowed_energy_transfer" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battery_swap_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"transaction_id" text,
	"id_token" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charging_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"source" charging_profile_source NOT NULL,
	"evse_id" integer,
	"request_id" integer,
	"charging_limit_source" varchar(50),
	"tbc" boolean DEFAULT false NOT NULL,
	"profile_data" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_information_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"request_id" integer NOT NULL,
	"seq_no" integer NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"tbc" boolean DEFAULT false NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "der_alarm_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"control_type" text,
	"timestamp" timestamp with time zone,
	"grid_event_fault" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "der_control_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"request_id" integer,
	"seq_no" integer,
	"tbc" boolean DEFAULT false NOT NULL,
	"der_control" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "der_start_stop_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"control_type" text,
	"started" boolean,
	"timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ev_charging_needs" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" integer NOT NULL,
	"charging_needs" jsonb NOT NULL,
	"departure_time" timestamp with time zone,
	"requested_energy_transfer" varchar(50),
	"control_mode" varchar(50),
	"max_schedule_tuples" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ev_charging_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" integer NOT NULL,
	"time_base" timestamp with time zone,
	"charging_schedule" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_alert_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"component" varchar(100) NOT NULL,
	"variable" varchar(100) NOT NULL,
	"min_severity" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"notify_channel" varchar(50) DEFAULT 'email' NOT NULL,
	"notify_recipient" varchar(500) DEFAULT '$admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"station_event_id" integer,
	"rule_id" integer,
	"component" varchar(100),
	"variable" varchar(100),
	"severity" integer,
	"trigger" varchar(50),
	"actual_value" text,
	"tech_info" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"request_id" integer,
	"firmware_url" text NOT NULL,
	"retrieve_date_time" timestamp with time zone,
	"status" "firmware_update_status",
	"status_info" jsonb,
	"campaign_id" text,
	"initiated_at" timestamp with time zone NOT NULL,
	"last_status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"request_id" integer,
	"log_type" varchar(50),
	"remote_location" text,
	"status" "log_upload_status",
	"status_info" jsonb,
	"initiated_at" timestamp with time zone,
	"last_status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitoring_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"request_id" integer NOT NULL,
	"seq_no" integer NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"tbc" boolean DEFAULT false NOT NULL,
	"monitor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offline_command_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"command_id" varchar(36) NOT NULL,
	"action" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"version" varchar(20),
	"status" "offline_command_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_command_queue_command_id_unique" UNIQUE("command_id")
);
--> statement-breakpoint
CREATE TABLE "periodic_event_streams" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"stream_id" integer NOT NULL,
	"data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qr_scan_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" integer,
	"timeout" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"type" varchar(100) NOT NULL,
	"severity" varchar(20) DEFAULT 'info' NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"tech_info" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_configurations" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"component" varchar(100) NOT NULL,
	"instance" varchar(50),
	"evse_id" integer,
	"connector_id" integer,
	"variable" varchar(100) NOT NULL,
	"variable_instance" varchar(50),
	"value" text,
	"attribute_type" varchar(20) DEFAULT 'Actual' NOT NULL,
	"source" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"seq_no" integer NOT NULL,
	"tbc" boolean DEFAULT false NOT NULL,
	"event_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variable_monitoring_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"monitoring_id" integer,
	"component" varchar(100) NOT NULL,
	"variable" varchar(100) NOT NULL,
	"type" varchar(50) NOT NULL,
	"value" numeric NOT NULL,
	"severity" integer DEFAULT 0 NOT NULL,
	"status" "variable_monitor_status" DEFAULT 'pending' NOT NULL,
	"error_info" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vat_number_validations" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"vat_number" text,
	"evse_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_payment_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"station_id" text NOT NULL,
	"evse_id" integer,
	"timeout" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_campaign_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"station_id" text NOT NULL,
	"status" "firmware_campaign_station_status" DEFAULT 'pending' NOT NULL,
	"error_info" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"firmware_url" text NOT NULL,
	"version" varchar(100),
	"status" "firmware_campaign_status" DEFAULT 'draft' NOT NULL,
	"target_filter" jsonb,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_template_push_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"push_id" text NOT NULL,
	"station_id" text NOT NULL,
	"status" "config_template_push_station_status" DEFAULT 'pending' NOT NULL,
	"error_info" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_template_pushes" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"status" "config_template_push_status" DEFAULT 'active' NOT NULL,
	"station_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ocpp_version" varchar(10) DEFAULT '2.1' NOT NULL,
	"target_filter" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" varchar(255) PRIMARY KEY NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"total_stations" integer,
	"online_stations" integer,
	"online_percent" numeric,
	"uptime_percent" numeric,
	"active_sessions" integer,
	"total_energy_wh" numeric,
	"day_energy_wh" numeric,
	"total_sessions" integer,
	"day_sessions" integer,
	"connected_stations" integer,
	"total_revenue_cents" integer,
	"day_revenue_cents" integer,
	"avg_revenue_cents_per_session" integer,
	"total_transactions" integer,
	"day_transactions" integer,
	"total_ports" integer,
	"stations_below_threshold" integer,
	"avg_ping_latency_ms" numeric,
	"ping_success_rate" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_dashboard_snapshots_site_date" UNIQUE("site_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "css_charging_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"profile_id" integer NOT NULL,
	"evse_id" integer,
	"profile_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_charging_profiles_station_profile" UNIQUE("css_station_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "css_config_variables" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"readonly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_config_variables_station_key" UNIQUE("css_station_id","key")
);
--> statement-breakpoint
CREATE TABLE "css_display_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"message_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_display_messages_station_message" UNIQUE("css_station_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "css_evses" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"evse_id" integer NOT NULL,
	"connector_id" integer DEFAULT 1 NOT NULL,
	"connector_type" "css_connector_type" DEFAULT 'ac_type2' NOT NULL,
	"max_power_w" integer DEFAULT 22000 NOT NULL,
	"phases" integer DEFAULT 3 NOT NULL,
	"voltage" integer DEFAULT 230 NOT NULL,
	"status" varchar(50) DEFAULT 'Available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_evses_station_evse_connector" UNIQUE("css_station_id","evse_id","connector_id")
);
--> statement-breakpoint
CREATE TABLE "css_installed_certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"certificate_type" varchar(100) NOT NULL,
	"serial_number" varchar(255) NOT NULL,
	"hash_algorithm" varchar(20) DEFAULT 'SHA256' NOT NULL,
	"issuer_name_hash" varchar(255),
	"issuer_key_hash" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_installed_certificates_station_serial" UNIQUE("css_station_id","serial_number")
);
--> statement-breakpoint
CREATE TABLE "css_local_auth_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"id_token" varchar(255) NOT NULL,
	"token_type" varchar(50),
	"auth_status" varchar(50) DEFAULT 'Accepted' NOT NULL,
	"list_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_local_auth_entries_station_token" UNIQUE("css_station_id","id_token")
);
--> statement-breakpoint
CREATE TABLE "css_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"reservation_id" integer NOT NULL,
	"evse_id" integer NOT NULL,
	"id_token" varchar(255) NOT NULL,
	"expiry_date_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_reservations_station_reservation" UNIQUE("css_station_id","reservation_id")
);
--> statement-breakpoint
CREATE TABLE "css_stations" (
	"id" text PRIMARY KEY NOT NULL,
	"station_id" varchar(255) NOT NULL,
	"ocpp_protocol" varchar(10) DEFAULT 'ocpp2.1' NOT NULL,
	"security_profile" integer DEFAULT 1 NOT NULL,
	"target_url" text NOT NULL,
	"password" varchar(255),
	"vendor_name" varchar(255) DEFAULT 'EVtivity' NOT NULL,
	"model" varchar(255) DEFAULT 'CSS-1000' NOT NULL,
	"serial_number" varchar(255),
	"firmware_version" varchar(50) DEFAULT '1.0.0' NOT NULL,
	"client_cert" text,
	"client_key" text,
	"ca_cert" text,
	"status" "css_station_status" DEFAULT 'disconnected' NOT NULL,
	"availability_state" varchar(50) DEFAULT 'Operative' NOT NULL,
	"boot_reason" varchar(50),
	"last_heartbeat_at" timestamp with time zone,
	"last_boot_at" timestamp with time zone,
	"source_type" varchar(20) DEFAULT 'api' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "css_stations_station_id_unique" UNIQUE("station_id")
);
--> statement-breakpoint
CREATE TABLE "css_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"css_station_id" text NOT NULL,
	"evse_id" integer NOT NULL,
	"transaction_id" varchar(255) NOT NULL,
	"id_token" varchar(255),
	"token_type" varchar(50),
	"status" "css_transaction_status" DEFAULT 'active' NOT NULL,
	"meter_start_wh" integer DEFAULT 0 NOT NULL,
	"meter_stop_wh" integer,
	"current_power_w" real DEFAULT 0 NOT NULL,
	"current_soc" real,
	"charging_state" varchar(50),
	"seq_no" integer DEFAULT 0 NOT NULL,
	"idle_started_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"stopped_reason" varchar(50),
	CONSTRAINT "css_transactions_station_transaction" UNIQUE("css_station_id","transaction_id")
);
--> statement-breakpoint
CREATE TABLE "charging_profile_push_stations" (
	"id" serial PRIMARY KEY NOT NULL,
	"push_id" text NOT NULL,
	"station_id" text NOT NULL,
	"status" charging_profile_push_station_status DEFAULT 'pending' NOT NULL,
	"error_info" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charging_profile_pushes" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"status" charging_profile_push_status DEFAULT 'active' NOT NULL,
	"station_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charging_profile_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"ocpp_version" varchar(10) DEFAULT '2.1' NOT NULL,
	"profile_id" integer DEFAULT 100 NOT NULL,
	"profile_purpose" varchar(50) NOT NULL,
	"profile_kind" varchar(20) NOT NULL,
	"recurrency_kind" varchar(10),
	"stack_level" integer DEFAULT 0 NOT NULL,
	"evse_id" integer DEFAULT 0 NOT NULL,
	"charging_rate_unit" varchar(1) DEFAULT 'W' NOT NULL,
	"schedule_periods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_schedule" timestamp with time zone,
	"duration" integer,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"target_filter" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_ai_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" varchar(20) NOT NULL,
	"api_key_enc" text NOT NULL,
	"model" varchar(100),
	"temperature" numeric,
	"top_p" numeric,
	"top_k" integer,
	"system_prompt" text,
	"support_ai_provider" varchar(20),
	"support_ai_api_key_enc" text,
	"support_ai_model" varchar(100),
	"support_ai_temperature" numeric,
	"support_ai_top_p" numeric,
	"support_ai_top_k" integer,
	"support_ai_system_prompt" text,
	"support_ai_tone" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatbot_ai_configs_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "carbon_intensity_factors" (
	"id" serial PRIMARY KEY NOT NULL,
	"region_code" varchar(20) NOT NULL,
	"region_name" varchar(255) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"carbon_intensity_kg_per_kwh" numeric NOT NULL,
	"source" varchar(100) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carbon_intensity_factors_region_code_unique" UNIQUE("region_code")
);
--> statement-breakpoint
CREATE TABLE "octt_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" "octt_run_status" DEFAULT 'pending' NOT NULL,
	"ocpp_version" varchar(10) NOT NULL,
	"sut_type" varchar(10) DEFAULT 'csms' NOT NULL,
	"total_tests" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"triggered_by" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "octt_test_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"test_id" varchar(50) NOT NULL,
	"test_name" varchar(200) NOT NULL,
	"module" varchar(50) NOT NULL,
	"ocpp_version" varchar(10) NOT NULL,
	"status" "octt_test_status" NOT NULL,
	"duration_ms" integer NOT NULL,
	"steps" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "charging_stations" ADD CONSTRAINT "charging_stations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_stations" ADD CONSTRAINT "charging_stations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_evse_id_evses_id_fk" FOREIGN KEY ("evse_id") REFERENCES "public"."evses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evses" ADD CONSTRAINT "evses_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_power_limits" ADD CONSTRAINT "site_power_limits_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_images" ADD CONSTRAINT "station_images_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_layout_positions" ADD CONSTRAINT "station_layout_positions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_layout_positions" ADD CONSTRAINT "station_layout_positions_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_favorite_stations" ADD CONSTRAINT "driver_favorite_stations_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_favorite_stations" ADD CONSTRAINT "driver_favorite_stations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_notification_preferences" ADD CONSTRAINT "driver_notification_preferences_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_drivers" ADD CONSTRAINT "fleet_drivers_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_drivers" ADD CONSTRAINT "fleet_drivers_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_stations" ADD CONSTRAINT "fleet_stations_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_stations" ADD CONSTRAINT "fleet_stations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_charging_session_id_charging_sessions_id_fk" FOREIGN KEY ("charging_session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_evse_id_evses_id_fk" FOREIGN KEY ("evse_id") REFERENCES "public"."evses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_sessions" ADD CONSTRAINT "charging_sessions_tariff_id_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."tariffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_evse_id_evses_id_fk" FOREIGN KEY ("evse_id") REFERENCES "public"."evses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_values" ADD CONSTRAINT "meter_values_session_id_charging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_session_id_charging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_site_assignments" ADD CONSTRAINT "user_site_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_site_assignments" ADD CONSTRAINT "user_site_assignments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_drivers" ADD CONSTRAINT "pricing_group_drivers_pricing_group_id_pricing_groups_id_fk" FOREIGN KEY ("pricing_group_id") REFERENCES "public"."pricing_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_drivers" ADD CONSTRAINT "pricing_group_drivers_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_fleets" ADD CONSTRAINT "pricing_group_fleets_pricing_group_id_pricing_groups_id_fk" FOREIGN KEY ("pricing_group_id") REFERENCES "public"."pricing_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_fleets" ADD CONSTRAINT "pricing_group_fleets_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_sites" ADD CONSTRAINT "pricing_group_sites_pricing_group_id_pricing_groups_id_fk" FOREIGN KEY ("pricing_group_id") REFERENCES "public"."pricing_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_sites" ADD CONSTRAINT "pricing_group_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_stations" ADD CONSTRAINT "pricing_group_stations_pricing_group_id_pricing_groups_id_fk" FOREIGN KEY ("pricing_group_id") REFERENCES "public"."pricing_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_group_stations" ADD CONSTRAINT "pricing_group_stations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tariff_segments" ADD CONSTRAINT "session_tariff_segments_tariff_id_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."tariffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariffs" ADD CONSTRAINT "tariffs_pricing_group_id_pricing_groups_id_fk" FOREIGN KEY ("pricing_group_id") REFERENCES "public"."pricing_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pki_csr_requests" ADD CONSTRAINT "pki_csr_requests_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_certificates" ADD CONSTRAINT "station_certificates_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_certificates" ADD CONSTRAINT "station_certificates_parent_ca_id_pki_ca_certificates_id_fk" FOREIGN KEY ("parent_ca_id") REFERENCES "public"."pki_ca_certificates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpp_message_logs" ADD CONSTRAINT "ocpp_message_logs_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_status_log" ADD CONSTRAINT "port_status_log_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_evse_id_evses_id_fk" FOREIGN KEY ("evse_id") REFERENCES "public"."evses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_fleet_reservation_id_fleet_reservations_id_fk" FOREIGN KEY ("fleet_reservation_id") REFERENCES "public"."fleet_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_reservations" ADD CONSTRAINT "fleet_reservations_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_reservations" ADD CONSTRAINT "fleet_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_payment_methods" ADD CONSTRAINT "driver_payment_methods_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_session_id_charging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_site_payment_config_id_site_payment_configs_id_fk" FOREIGN KEY ("site_payment_config_id") REFERENCES "public"."site_payment_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_payment_configs" ADD CONSTRAINT "site_payment_configs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_allocation_log" ADD CONSTRAINT "load_allocation_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_load_management" ADD CONSTRAINT "site_load_management_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmanaged_loads" ADD CONSTRAINT "unmanaged_loads_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmanaged_loads" ADD CONSTRAINT "unmanaged_loads_circuit_id_circuits_id_fk" FOREIGN KEY ("circuit_id") REFERENCES "public"."circuits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_messages" ADD CONSTRAINT "display_messages_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nevi_excluded_downtime" ADD CONSTRAINT "nevi_excluded_downtime_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nevi_excluded_downtime" ADD CONSTRAINT "nevi_excluded_downtime_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nevi_station_data" ADD CONSTRAINT "nevi_station_data_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_generated_by_id_users_id_fk" FOREIGN KEY ("generated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_session_id_charging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_attachments" ADD CONSTRAINT "support_case_attachments_message_id_support_case_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_case_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_reads" ADD CONSTRAINT "support_case_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_reads" ADD CONSTRAINT "support_case_reads_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_sessions" ADD CONSTRAINT "support_case_sessions_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_sessions" ADD CONSTRAINT "support_case_sessions_session_id_charging_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_cdrs" ADD CONSTRAINT "ocpi_cdrs_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_cdrs" ADD CONSTRAINT "ocpi_cdrs_charging_session_id_charging_sessions_id_fk" FOREIGN KEY ("charging_session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_credentials_tokens" ADD CONSTRAINT "ocpi_credentials_tokens_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_external_locations" ADD CONSTRAINT "ocpi_external_locations_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_external_tariffs" ADD CONSTRAINT "ocpi_external_tariffs_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_external_tokens" ADD CONSTRAINT "ocpi_external_tokens_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_location_publish" ADD CONSTRAINT "ocpi_location_publish_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_location_publish_partners" ADD CONSTRAINT "ocpi_location_publish_partners_location_publish_id_ocpi_location_publish_id_fk" FOREIGN KEY ("location_publish_id") REFERENCES "public"."ocpi_location_publish"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_location_publish_partners" ADD CONSTRAINT "ocpi_location_publish_partners_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_partner_endpoints" ADD CONSTRAINT "ocpi_partner_endpoints_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_roaming_sessions" ADD CONSTRAINT "ocpi_roaming_sessions_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_roaming_sessions" ADD CONSTRAINT "ocpi_roaming_sessions_charging_session_id_charging_sessions_id_fk" FOREIGN KEY ("charging_session_id") REFERENCES "public"."charging_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_sync_log" ADD CONSTRAINT "ocpi_sync_log_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_tariff_mappings" ADD CONSTRAINT "ocpi_tariff_mappings_tariff_id_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."tariffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocpi_tariff_mappings" ADD CONSTRAINT "ocpi_tariff_mappings_partner_id_ocpi_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."ocpi_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_local_auth_entries" ADD CONSTRAINT "station_local_auth_entries_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_local_auth_entries" ADD CONSTRAINT "station_local_auth_entries_driver_token_id_driver_tokens_id_fk" FOREIGN KEY ("driver_token_id") REFERENCES "public"."driver_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_local_auth_versions" ADD CONSTRAINT "station_local_auth_versions_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowed_energy_transfer_events" ADD CONSTRAINT "allowed_energy_transfer_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battery_swap_events" ADD CONSTRAINT "battery_swap_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_profiles" ADD CONSTRAINT "charging_profiles_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_information_reports" ADD CONSTRAINT "customer_information_reports_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "der_alarm_events" ADD CONSTRAINT "der_alarm_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "der_control_reports" ADD CONSTRAINT "der_control_reports_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "der_start_stop_events" ADD CONSTRAINT "der_start_stop_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_charging_needs" ADD CONSTRAINT "ev_charging_needs_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_charging_schedules" ADD CONSTRAINT "ev_charging_schedules_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_alerts" ADD CONSTRAINT "event_alerts_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_alerts" ADD CONSTRAINT "event_alerts_station_event_id_station_events_id_fk" FOREIGN KEY ("station_event_id") REFERENCES "public"."station_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_alerts" ADD CONSTRAINT "event_alerts_rule_id_event_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."event_alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_alerts" ADD CONSTRAINT "event_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_updates" ADD CONSTRAINT "firmware_updates_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_uploads" ADD CONSTRAINT "log_uploads_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_reports" ADD CONSTRAINT "monitoring_reports_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodic_event_streams" ADD CONSTRAINT "periodic_event_streams_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_scan_events" ADD CONSTRAINT "qr_scan_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_configurations" ADD CONSTRAINT "station_configurations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_events" ADD CONSTRAINT "station_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_monitoring_rules" ADD CONSTRAINT "variable_monitoring_rules_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_number_validations" ADD CONSTRAINT "vat_number_validations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_payment_events" ADD CONSTRAINT "web_payment_events_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_campaign_stations" ADD CONSTRAINT "firmware_campaign_stations_campaign_id_firmware_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."firmware_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firmware_campaign_stations" ADD CONSTRAINT "firmware_campaign_stations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_template_push_stations" ADD CONSTRAINT "config_template_push_stations_push_id_config_template_pushes_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."config_template_pushes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_template_push_stations" ADD CONSTRAINT "config_template_push_stations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_template_pushes" ADD CONSTRAINT "config_template_pushes_template_id_config_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."config_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_charging_profiles" ADD CONSTRAINT "css_charging_profiles_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_config_variables" ADD CONSTRAINT "css_config_variables_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_display_messages" ADD CONSTRAINT "css_display_messages_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_evses" ADD CONSTRAINT "css_evses_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_installed_certificates" ADD CONSTRAINT "css_installed_certificates_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_local_auth_entries" ADD CONSTRAINT "css_local_auth_entries_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_reservations" ADD CONSTRAINT "css_reservations_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "css_transactions" ADD CONSTRAINT "css_transactions_css_station_id_css_stations_id_fk" FOREIGN KEY ("css_station_id") REFERENCES "public"."css_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_profile_push_stations" ADD CONSTRAINT "charging_profile_push_stations_push_id_charging_profile_pushes_id_fk" FOREIGN KEY ("push_id") REFERENCES "public"."charging_profile_pushes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_profile_push_stations" ADD CONSTRAINT "charging_profile_push_stations_station_id_charging_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."charging_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charging_profile_pushes" ADD CONSTRAINT "charging_profile_pushes_template_id_charging_profile_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."charging_profile_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatbot_ai_configs" ADD CONSTRAINT "chatbot_ai_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "octt_runs" ADD CONSTRAINT "octt_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "octt_test_results" ADD CONSTRAINT "octt_test_results_run_id_octt_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."octt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_charging_stations_availability" ON "charging_stations" USING btree ("availability");--> statement-breakpoint
CREATE INDEX "idx_charging_stations_onboarding_status" ON "charging_stations" USING btree ("onboarding_status");--> statement-breakpoint
CREATE INDEX "idx_charging_stations_is_online" ON "charging_stations" USING btree ("is_online");--> statement-breakpoint
CREATE INDEX "idx_charging_stations_is_simulator" ON "charging_stations" USING btree ("is_simulator");--> statement-breakpoint
CREATE INDEX "idx_charging_stations_site_id" ON "charging_stations" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "idx_charging_stations_vendor_id" ON "charging_stations" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "idx_connectors_evse_id" ON "connectors" USING btree ("evse_id");--> statement-breakpoint
CREATE INDEX "idx_connectors_evse_status" ON "connectors" USING btree ("evse_id","status");--> statement-breakpoint
CREATE INDEX "idx_evses_station_id" ON "evses" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_station_images_station_id" ON "station_images" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_station_layout_site" ON "station_layout_positions" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_driver_favorite_stations_unique" ON "driver_favorite_stations" USING btree ("driver_id","station_id");--> statement-breakpoint
CREATE INDEX "idx_driver_favorite_stations_driver" ON "driver_favorite_stations" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_driver_tokens_id_token" ON "driver_tokens" USING btree ("id_token");--> statement-breakpoint
CREATE INDEX "idx_driver_tokens_driver_id" ON "driver_tokens" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_drivers_email" ON "drivers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_fleet_drivers_fleet_id" ON "fleet_drivers" USING btree ("fleet_id");--> statement-breakpoint
CREATE INDEX "idx_fleet_drivers_driver_id" ON "fleet_drivers" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_fleet_stations_fleet_id" ON "fleet_stations" USING btree ("fleet_id");--> statement-breakpoint
CREATE INDEX "idx_fleet_stations_station_id" ON "fleet_stations" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_guest_sessions_station" ON "guest_sessions" USING btree ("station_ocpp_id","evse_id");--> statement-breakpoint
CREATE INDEX "idx_guest_sessions_token" ON "guest_sessions" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "idx_guest_sessions_status" ON "guest_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_guest_sessions_charging_session" ON "guest_sessions" USING btree ("charging_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_vel_make_model_year" ON "vehicle_efficiency_lookup" USING btree (LOWER("make"),LOWER("model"),COALESCE("year", ''));--> statement-breakpoint
CREATE INDEX "idx_sessions_station_id" ON "charging_sessions" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_status" ON "charging_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sessions_transaction_id" ON "charging_sessions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_started_at" ON "charging_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_driver_id" ON "charging_sessions" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_reservation_id" ON "charging_sessions" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_status_idle" ON "charging_sessions" USING btree ("status","idle_started_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_created_at" ON "charging_sessions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_station_status" ON "charging_sessions" USING btree ("station_id","status");--> statement-breakpoint
CREATE INDEX "idx_sessions_evse_id" ON "charging_sessions" USING btree ("evse_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_connector_id" ON "charging_sessions" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_tariff_id" ON "charging_sessions" USING btree ("tariff_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_driver_status" ON "charging_sessions" USING btree ("driver_id","status");--> statement-breakpoint
CREATE INDEX "idx_meter_values_station_id" ON "meter_values" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_meter_values_session_id" ON "meter_values" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_meter_values_timestamp" ON "meter_values" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_transaction_events_session_id" ON "transaction_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_events_timestamp" ON "transaction_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_mfa_challenges_user_id" ON "mfa_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_mfa_challenges_driver_id" ON "mfa_challenges" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_user_id" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_driver_id" ON "refresh_tokens" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_token_hash" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_permissions_user_perm" ON "user_permissions" USING btree ("user_id","permission");--> statement-breakpoint
CREATE INDEX "idx_user_permissions_user_id" ON "user_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_site_assignments_user_id" ON "user_site_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_site_assignments_site_id" ON "user_site_assignments" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_site_assignments_unique" ON "user_site_assignments" USING btree ("user_id","site_id");--> statement-breakpoint
CREATE INDEX "idx_user_tokens_user_id" ON "user_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_tokens_driver_id" ON "user_tokens" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_user_tokens_token_hash" ON "user_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_users_role_id" ON "users" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_drivers_group_id" ON "pricing_group_drivers" USING btree ("pricing_group_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_drivers_driver_id" ON "pricing_group_drivers" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_fleets_group_id" ON "pricing_group_fleets" USING btree ("pricing_group_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_fleets_fleet_id" ON "pricing_group_fleets" USING btree ("fleet_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_sites_group_id" ON "pricing_group_sites" USING btree ("pricing_group_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_sites_site_id" ON "pricing_group_sites" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_stations_group_id" ON "pricing_group_stations" USING btree ("pricing_group_id");--> statement-breakpoint
CREATE INDEX "idx_pricing_group_stations_station_id" ON "pricing_group_stations" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_session_tariff_segments_session" ON "session_tariff_segments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_tariffs_group_active" ON "tariffs" USING btree ("pricing_group_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_pki_ca_cert_type_status" ON "pki_ca_certificates" USING btree ("certificate_type","status");--> statement-breakpoint
CREATE INDEX "idx_pki_csr_station_status" ON "pki_csr_requests" USING btree ("station_id","status");--> statement-breakpoint
CREATE INDEX "idx_station_certificates_station_id" ON "station_certificates" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_station_certificates_status" ON "station_certificates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_access_logs_user_id" ON "access_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_access_logs_driver_id" ON "access_logs" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_access_logs_category" ON "access_logs" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_access_logs_created_at" ON "access_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_access_logs_action" ON "access_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_connection_logs_station_id" ON "connection_logs" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_connection_logs_created_at" ON "connection_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_ocpp_message_logs_station_id" ON "ocpp_message_logs" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_ocpp_message_logs_action" ON "ocpp_message_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_ocpp_message_logs_created_at" ON "ocpp_message_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_ocpp_message_logs_message_id" ON "ocpp_message_logs" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_port_status_log_station_id" ON "port_status_log" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_port_status_log_timestamp" ON "port_status_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_port_status_log_station_evse" ON "port_status_log" USING btree ("station_id","evse_id");--> statement-breakpoint
CREATE INDEX "idx_worker_job_logs_job_name" ON "worker_job_logs" USING btree ("job_name");--> statement-breakpoint
CREATE INDEX "idx_worker_job_logs_queue" ON "worker_job_logs" USING btree ("queue");--> statement-breakpoint
CREATE INDEX "idx_worker_job_logs_started_at" ON "worker_job_logs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_domain_events_event_type" ON "domain_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_domain_events_aggregate" ON "domain_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "idx_domain_events_occurred_at" ON "domain_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_reservations_station_id" ON "reservations" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_reservations_status" ON "reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fleet_reservations_fleet_id" ON "fleet_reservations" USING btree ("fleet_id");--> statement-breakpoint
CREATE INDEX "idx_fleet_reservations_status" ON "fleet_reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notifications_status" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notifications_created_at" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_status_created" ON "notifications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_cronjobs_name" ON "cronjobs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_cronjobs_next_run_at" ON "cronjobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_driver_payment_methods_driver_id" ON "driver_payment_methods" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_driver_payment_methods_stripe_customer_id" ON "driver_payment_methods" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "idx_payment_records_session_id" ON "payment_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_payment_records_driver_id" ON "payment_records" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_payment_records_status" ON "payment_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_payment_records_stripe_payment_intent_id" ON "payment_records" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "idx_payment_records_created_at" ON "payment_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_payment_records_site_payment_config_id" ON "payment_records" USING btree ("site_payment_config_id");--> statement-breakpoint
CREATE INDEX "idx_circuits_panel" ON "circuits" USING btree ("panel_id");--> statement-breakpoint
CREATE INDEX "idx_load_alloc_log_site" ON "load_allocation_log" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "idx_load_alloc_log_created" ON "load_allocation_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_panels_site" ON "panels" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "idx_panels_parent" ON "panels" USING btree ("parent_panel_id");--> statement-breakpoint
CREATE INDEX "idx_unmanaged_loads_panel" ON "unmanaged_loads" USING btree ("panel_id");--> statement-breakpoint
CREATE INDEX "idx_unmanaged_loads_circuit" ON "unmanaged_loads" USING btree ("circuit_id");--> statement-breakpoint
CREATE INDEX "idx_display_messages_station_id" ON "display_messages" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_display_messages_status" ON "display_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_nevi_excluded_downtime_station" ON "nevi_excluded_downtime" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_nevi_excluded_downtime_started_at" ON "nevi_excluded_downtime" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_report_schedules_next_run" ON "report_schedules" USING btree ("next_run_at","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_report_schedules_created_by" ON "report_schedules" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "idx_reports_generated_by_id" ON "reports" USING btree ("generated_by_id");--> statement-breakpoint
CREATE INDEX "idx_reports_report_type" ON "reports" USING btree ("report_type");--> statement-breakpoint
CREATE INDEX "idx_reports_created_at" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_status" ON "reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_invoice_line_items_invoice_id" ON "invoice_line_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_invoice_line_items_session_id" ON "invoice_line_items" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_driver_id" ON "invoices" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_status" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_invoices_invoice_number" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "idx_support_case_attachments_message_id" ON "support_case_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_support_case_messages_case_id" ON "support_case_messages" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_support_case_reads_user_id" ON "support_case_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_support_case_sessions_session_id" ON "support_case_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_support_cases_driver_id" ON "support_cases" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_support_cases_status" ON "support_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_support_cases_category" ON "support_cases" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_support_cases_priority" ON "support_cases" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_support_cases_assigned_to" ON "support_cases" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_support_cases_case_number" ON "support_cases" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "idx_support_cases_created_at" ON "support_cases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_support_cases_station_id" ON "support_cases" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_support_cases_status_assigned" ON "support_cases" USING btree ("status","assigned_to");--> statement-breakpoint
CREATE INDEX "idx_ocpi_cdrs_partner" ON "ocpi_cdrs" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_cdrs_ocpi_id" ON "ocpi_cdrs" USING btree ("ocpi_cdr_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_cdrs_push_status" ON "ocpi_cdrs" USING btree ("push_status");--> statement-breakpoint
CREATE INDEX "idx_ocpi_cdrs_charging" ON "ocpi_cdrs" USING btree ("charging_session_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_credentials_tokens_prefix_active" ON "ocpi_credentials_tokens" USING btree ("token_prefix","is_active");--> statement-breakpoint
CREATE INDEX "idx_ocpi_credentials_tokens_partner" ON "ocpi_credentials_tokens" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_external_locations_partner" ON "ocpi_external_locations" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_external_locations_coords" ON "ocpi_external_locations" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "idx_ocpi_external_tariffs_partner" ON "ocpi_external_tariffs" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_external_tokens_partner" ON "ocpi_external_tokens" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_external_tokens_uid" ON "ocpi_external_tokens" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "idx_ocpi_partner_endpoints_partner" ON "ocpi_partner_endpoints" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_partners_status" ON "ocpi_partners" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ocpi_roaming_sessions_partner" ON "ocpi_roaming_sessions" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_roaming_sessions_ocpi_id" ON "ocpi_roaming_sessions" USING btree ("ocpi_session_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_roaming_sessions_charging" ON "ocpi_roaming_sessions" USING btree ("charging_session_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_sync_log_partner" ON "ocpi_sync_log" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_sync_log_created" ON "ocpi_sync_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_ocpi_tariff_mappings_tariff" ON "ocpi_tariff_mappings" USING btree ("tariff_id");--> statement-breakpoint
CREATE INDEX "idx_ocpi_tariff_mappings_partner" ON "ocpi_tariff_mappings" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "idx_local_auth_entries_station_id" ON "station_local_auth_entries" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_local_auth_entries_driver_token_id" ON "station_local_auth_entries" USING btree ("driver_token_id");--> statement-breakpoint
CREATE INDEX "idx_allowed_energy_transfer_events_station" ON "allowed_energy_transfer_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_battery_swap_events_station" ON "battery_swap_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_charging_profiles_station_id" ON "charging_profiles" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_charging_profiles_source" ON "charging_profiles" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_charging_profiles_evse_id" ON "charging_profiles" USING btree ("evse_id");--> statement-breakpoint
CREATE INDEX "idx_customer_info_reports_station_id" ON "customer_information_reports" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_customer_info_reports_request_id" ON "customer_information_reports" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_der_alarm_events_station" ON "der_alarm_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_der_control_reports_station" ON "der_control_reports" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_der_start_stop_events_station" ON "der_start_stop_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_ev_charging_needs_station_id" ON "ev_charging_needs" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ev_charging_needs_station_evse" ON "ev_charging_needs" USING btree ("station_id","evse_id");--> statement-breakpoint
CREATE INDEX "idx_ev_charging_schedules_station_id" ON "ev_charging_schedules" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_event_alert_rules_component_variable" ON "event_alert_rules" USING btree ("component","variable");--> statement-breakpoint
CREATE INDEX "idx_event_alerts_station" ON "event_alerts" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_event_alerts_severity" ON "event_alerts" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_event_alerts_acknowledged" ON "event_alerts" USING btree ("acknowledged_at");--> statement-breakpoint
CREATE INDEX "idx_firmware_updates_station_id" ON "firmware_updates" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_firmware_updates_request_id" ON "firmware_updates" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_firmware_updates_status" ON "firmware_updates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_log_uploads_station_id" ON "log_uploads" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_log_uploads_request_id" ON "log_uploads" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_monitoring_reports_station_id" ON "monitoring_reports" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_monitoring_reports_request_id" ON "monitoring_reports" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_offline_cmd_queue_station_id" ON "offline_command_queue" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_offline_cmd_queue_status" ON "offline_command_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_offline_cmd_queue_expires_at" ON "offline_command_queue" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_periodic_event_streams_station" ON "periodic_event_streams" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_qr_scan_events_station" ON "qr_scan_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_security_events_station_id" ON "security_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_security_events_type" ON "security_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_security_events_severity" ON "security_events" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_security_events_timestamp" ON "security_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_station_configurations_station_id" ON "station_configurations" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_station_configurations_composite" ON "station_configurations" USING btree ("station_id","component","variable",COALESCE(evse_id, -1),COALESCE(connector_id, -1),"attribute_type");--> statement-breakpoint
CREATE INDEX "idx_station_events_station_id" ON "station_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_station_events_generated_at" ON "station_events" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX "idx_variable_monitoring_rules_station_id" ON "variable_monitoring_rules" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_variable_monitoring_rules_status" ON "variable_monitoring_rules" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_vat_number_validations_station" ON "vat_number_validations" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_web_payment_events_station" ON "web_payment_events" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_firmware_campaign_stations_campaign" ON "firmware_campaign_stations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_firmware_campaign_stations_station" ON "firmware_campaign_stations" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_firmware_campaigns_status" ON "firmware_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_config_template_push_stations_push" ON "config_template_push_stations" USING btree ("push_id");--> statement-breakpoint
CREATE INDEX "idx_config_template_push_stations_station" ON "config_template_push_stations" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_config_template_pushes_template" ON "config_template_pushes" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_dashboard_snapshots_date" ON "dashboard_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE INDEX "idx_css_charging_profiles_css_station_id" ON "css_charging_profiles" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_config_variables_css_station_id" ON "css_config_variables" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_display_messages_css_station_id" ON "css_display_messages" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_evses_css_station_id" ON "css_evses" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_installed_certificates_css_station_id" ON "css_installed_certificates" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_local_auth_entries_css_station_id" ON "css_local_auth_entries" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_reservations_css_station_id" ON "css_reservations" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_stations_enabled" ON "css_stations" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "idx_css_stations_status" ON "css_stations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_css_transactions_css_station_id" ON "css_transactions" USING btree ("css_station_id");--> statement-breakpoint
CREATE INDEX "idx_css_transactions_status" ON "css_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_cp_push_stations_push" ON "charging_profile_push_stations" USING btree ("push_id");--> statement-breakpoint
CREATE INDEX "idx_cp_push_stations_station" ON "charging_profile_push_stations" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "idx_cp_pushes_template" ON "charging_profile_pushes" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_chatbot_ai_configs_user" ON "chatbot_ai_configs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_carbon_factors_country_code" ON "carbon_intensity_factors" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "idx_octt_test_results_run_id" ON "octt_test_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_octt_test_results_test_id" ON "octt_test_results" USING btree ("test_id");