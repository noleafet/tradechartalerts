import logging
import os
from datetime import timedelta
from urllib.parse import urlsplit

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.interval import IntervalTrigger
from playwright.sync_api import sync_playwright

from alerts.models import AppConfiguration
from alerts.services import check_alerts

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Schedule recurring checks for active alerts using the configured poll interval."

    def add_arguments(self, parser):
        parser.add_argument("--interval", type=int, default=None,
                            help="Override the poll interval stored in Alert configuration.")

    def handle(self, *args, **options):
        override = options["interval"]
        configuration = AppConfiguration.load()
        interval = override if override is not None else configuration.alert_poll_seconds
        if interval < 1:
            raise CommandError("The configured polling interval must be at least 1 second.")
        interval_state = {"seconds": interval}
        site_visit_url = os.getenv("SITE_VISIT_URL", "").strip()
        try:
            site_visit_interval = int(os.getenv("SITE_VISIT_INTERVAL_SECONDS", "600"))
        except ValueError as exc:
            raise CommandError("SITE_VISIT_INTERVAL_SECONDS must be an integer.") from exc
        if site_visit_interval < 1:
            raise CommandError("SITE_VISIT_INTERVAL_SECONDS must be at least 1 second.")
        if site_visit_url:
            parsed_url = urlsplit(site_visit_url)
            if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
                raise CommandError("SITE_VISIT_URL must be an absolute HTTP or HTTPS URL.")

        scheduler = BlockingScheduler(timezone=timezone.get_current_timezone())

        def poll_alerts():
            try:
                self.stdout.write(f"Checking active alerts (poll interval: {interval_state['seconds']}s).")
                check_alerts(stdout=self.stdout)
            except Exception:
                logger.exception("Scheduled alert check failed")
                self.stderr.write(self.style.ERROR("Alert check failed; it will be retried on the next scheduled run."))

            if override is None:
                current_interval = AppConfiguration.load().alert_poll_seconds
                if current_interval < 1:
                    logger.error("Ignoring invalid configured alert poll interval: %s", current_interval)
                    return
                job = scheduler.get_job("check-configured-alerts")
                scheduled_interval = job.trigger.interval.total_seconds() if job else current_interval
                if current_interval != scheduled_interval:
                    scheduler.reschedule_job(
                        "check-configured-alerts",
                        trigger=IntervalTrigger(seconds=current_interval, timezone=timezone.get_current_timezone()),
                        next_run_time=timezone.now() + timedelta(seconds=current_interval),
                    )
                    interval_state["seconds"] = current_interval
                    logger.info("Alert polling interval updated to %s seconds", current_interval)

        def visit_configured_site():
            try:
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(
                        headless=True,
                        args=["--no-sandbox"],
                    )
                    try:
                        page = browser.new_page()
                        response = page.goto(site_visit_url, wait_until="domcontentloaded", timeout=30_000)
                        page.wait_for_timeout(5_000)
                        status_code = response.status if response else "no response"
                        self.stdout.write(
                            f"Visited {site_visit_url} in headless Chromium; HTTP status: {status_code}."
                        )
                    finally:
                        browser.close()
            except Exception:
                logger.exception("Scheduled browser visit failed for %s", site_visit_url)
                self.stderr.write(self.style.ERROR("Browser visit failed; it will be retried on the next run."))

        def report_job(event):
            if event.exception:
                logger.error("Scheduler job failed: %s", event.exception)
            else:
                logger.debug("Scheduler completed alert check job")

        scheduler.add_listener(report_job, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)
        scheduler.add_job(
            poll_alerts,
            trigger=IntervalTrigger(seconds=interval, timezone=timezone.get_current_timezone()),
            id="check-configured-alerts",
            next_run_time=timezone.now(),
            max_instances=1,
            coalesce=True,
        )
        if site_visit_url:
            scheduler.add_job(
                visit_configured_site,
                trigger=IntervalTrigger(seconds=site_visit_interval, timezone=timezone.get_current_timezone()),
                id="visit-configured-site",
                next_run_time=timezone.now(),
                max_instances=1,
                coalesce=True,
            )
            self.stdout.write(self.style.SUCCESS(
                f"Browser visit enabled for {site_visit_url}; repeating every {site_visit_interval}s."
            ))
        else:
            self.stdout.write("Browser visit disabled; set SITE_VISIT_URL to enable it.")
        self.stdout.write(self.style.SUCCESS(
            f"Alert scheduler started; checking immediately, then every {interval}s. Ctrl+C stops it."
        ))
        try:
            scheduler.start()
        except KeyboardInterrupt:
            scheduler.shutdown(wait=False)
            self.stdout.write("\nAlert scheduler stopped.")
