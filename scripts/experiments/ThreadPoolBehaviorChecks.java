import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Mechanism checks; no external services and no throughput claims. */
public class ThreadPoolBehaviorChecks {
    static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }
    static void await(CountDownLatch latch) throws InterruptedException {
        check(latch.await(5, TimeUnit.SECONDS), "latch timed out");
    }
    static Runnable held(CountDownLatch started, CountDownLatch release) {
        return () -> {
            started.countDown();
            try {
                check(release.await(5, TimeUnit.SECONDS), "release timed out");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        };
    }
    static ThreadFactory namedFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        ThreadFactory defaults = Executors.defaultThreadFactory();
        return worker -> {
            Thread thread = defaults.newThread(worker);
            thread.setName(prefix + "-" + sequence.incrementAndGet());
            thread.setDaemon(false);
            thread.setUncaughtExceptionHandler((t, failure) ->
                System.err.println(t.getName() + " failed: " + failure));
            return thread;
        };
    }
    static ThreadPoolExecutor pool(int core, int max, BlockingQueue<Runnable> queue,
                                   RejectedExecutionHandler handler) {
        return new ThreadPoolExecutor(core, max, 30, TimeUnit.SECONDS,
            queue, namedFactory("check"), handler);
    }
    static void stop(ExecutorService pool) throws InterruptedException {
        for (Runnable task : pool.shutdownNow()) {
            if (task instanceof Future<?>) ((Future<?>) task).cancel(false);
        }
        check(pool.awaitTermination(5, TimeUnit.SECONDS), "pool did not terminate");
    }
    static void lazyCore() throws Exception {
        ThreadPoolExecutor p = pool(2, 4, new ArrayBlockingQueue<>(2),
            new ThreadPoolExecutor.AbortPolicy());
        try {
            check(p.getPoolSize() == 0, "constructor created threads");
            check(p.prestartAllCoreThreads() == 2, "prestart count");
            check(p.getPoolSize() == 2, "prestart pool size");
        } finally { stop(p); }
    }
    static void admission() throws Exception {
        ThreadPoolExecutor p = pool(2, 4, new ArrayBlockingQueue<>(2),
            new ThreadPoolExecutor.AbortPolicy());
        CountDownLatch started = new CountDownLatch(4);
        CountDownLatch release = new CountDownLatch(1);
        Set<String> running = ConcurrentHashMap.newKeySet();
        try {
            for (String name : Arrays.asList("A", "B", "C", "D", "E", "F")) {
                p.execute(() -> {
                    running.add(name);
                    held(started, release).run();
                });
            }
            await(started);
            check(p.getPoolSize() == 4 && p.getQueue().size() == 2, "2/4/2 state");
            check(running.containsAll(Arrays.asList("A", "B", "E", "F")),
                "first tasks did not bypass queue");
            check(!running.contains("C") && !running.contains("D"), "queued tasks ran early");
            try {
                p.execute(() -> {});
                throw new AssertionError("G should reject");
            } catch (RejectedExecutionException expected) {}
            release.countDown();
            p.shutdown();
            check(p.awaitTermination(5, TimeUnit.SECONDS), "accepted tasks did not finish");
            check(running.size() == 6, "accepted task missing");
        } finally { release.countDown(); stop(p); }
    }
    static void unboundedQueue() throws Exception {
        ThreadPoolExecutor p = pool(1, 3, new LinkedBlockingQueue<>(),
            new ThreadPoolExecutor.AbortPolicy());
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            p.execute(held(started, release));
            await(started);
            for (int i = 0; i < 5; i++) p.execute(() -> {});
            check(p.getPoolSize() == 1 && p.getQueue().size() == 5,
                "unbounded queue unexpectedly expanded");
        } finally { release.countDown(); stop(p); }
    }
    static class ObservedPool extends ThreadPoolExecutor {
        final AtomicReference<Throwable> observed = new AtomicReference<>();
        final CountDownLatch failed = new CountDownLatch(1);
        ObservedPool(ThreadFactory factory) {
            super(1, 1, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16),
                factory, new AbortPolicy());
        }
        @Override protected void afterExecute(Runnable task, Throwable failure) {
            super.afterExecute(task, failure);
            if (failure != null) return; // handled by UncaughtExceptionHandler
            if (task instanceof Future<?> && ((Future<?>) task).isDone()) {
                try {
                    ((Future<?>) task).get();
                } catch (CancellationException cancelled) {
                    // Cancellation is not execution failure.
                } catch (ExecutionException e) {
                    observed.set(e.getCause());
                    failed.countDown();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }
    static void results() throws Exception {
        CountDownLatch uncaught = new CountDownLatch(1);
        AtomicInteger uncaughtCount = new AtomicInteger();
        AtomicReference<String> brokenThread = new AtomicReference<>();
        ThreadFactory names = namedFactory("results");
        ObservedPool p = new ObservedPool(worker -> {
            Thread t = names.newThread(worker);
            t.setUncaughtExceptionHandler((thread, failure) -> {
                check(failure instanceof IllegalStateException, "wrong raw failure");
                uncaughtCount.incrementAndGet();
                uncaught.countDown();
            });
            return t;
        });
        try {
            p.execute(() -> {
                brokenThread.set(Thread.currentThread().getName());
                throw new IllegalStateException("execute failure");
            });
            await(uncaught);
            String replacement = p.submit(() -> Thread.currentThread().getName())
                .get(5, TimeUnit.SECONDS);
            check(!replacement.equals(brokenThread.get()), "failed worker was not replaced");
            Future<Integer> failure = p.submit(() -> {
                throw new IllegalArgumentException("submit failure");
            });
            try {
                failure.get(5, TimeUnit.SECONDS);
                throw new AssertionError("get should report failure");
            } catch (ExecutionException e) {
                check(e.getCause() instanceof IllegalArgumentException, "wrong Future cause");
            }
            await(p.failed);
            check(p.observed.get() instanceof IllegalArgumentException, "hook missed failure");
            check(uncaughtCount.get() == 1, "Future failure reached uncaught handler");
            check(replacement.equals(p.submit(() -> Thread.currentThread().getName())
                .get(5, TimeUnit.SECONDS)), "submit killed worker");
            check(p.submit(() -> {}).get(5, TimeUnit.SECONDS) == null, "Runnable result");
            check("OK".equals(p.submit(() -> {}, "OK").get(5, TimeUnit.SECONDS)),
                "supplied Runnable result");
            check(p.submit(() -> 42).get(5, TimeUnit.SECONDS) == 42, "Callable result");
        } finally { stop(p); }
    }
    static void callerRuns() throws Exception {
        ThreadPoolExecutor p = pool(1, 1, new ArrayBlockingQueue<>(1),
            new ThreadPoolExecutor.CallerRunsPolicy());
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            p.execute(held(started, release));
            await(started);
            p.execute(() -> {});
            String caller = Thread.currentThread().getName();
            check(caller.equals(p.submit(() -> Thread.currentThread().getName())
                .get(5, TimeUnit.SECONDS)), "CallerRuns did not run in caller");
            release.countDown();
            stop(p);
            Future<?> dropped = p.submit(() -> {});
            check(!dropped.isDone(), "closed CallerRuns completed discarded Future");
            dropped.cancel(false);
        } finally { release.countDown(); stop(p); }
    }
    static void discardFuture() throws Exception {
        ThreadPoolExecutor p = pool(1, 1, new ArrayBlockingQueue<>(1),
            new ThreadPoolExecutor.DiscardPolicy());
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            p.execute(held(started, release));
            await(started);
            p.execute(() -> {});
            Future<?> dropped = p.submit(() -> {});
            check(!dropped.isDone(), "discard completed Future");
            try {
                dropped.get(20, TimeUnit.MILLISECONDS);
                throw new AssertionError("discarded Future should not return");
            } catch (TimeoutException expected) {}
            dropped.cancel(false);
        } finally { release.countDown(); stop(p); }
    }
    static void scheduled() throws Exception {
        ScheduledThreadPoolExecutor p = new ScheduledThreadPoolExecutor(1, namedFactory("timer"));
        p.setRemoveOnCancelPolicy(true);
        try {
            ScheduledFuture<?> delayed = p.schedule(() -> {}, 1, TimeUnit.DAYS);
            check(p.getQueue().size() == 1, "delay missing");
            delayed.cancel(false);
            check(p.getQueue().isEmpty(), "cancelled delay retained");
            AtomicInteger runs = new AtomicInteger();
            ScheduledFuture<?> periodic = p.scheduleAtFixedRate(() -> {
                runs.incrementAndGet();
                throw new IllegalStateException("periodic failure");
            }, 0, 1, TimeUnit.MILLISECONDS);
            try {
                periodic.get(5, TimeUnit.SECONDS);
                throw new AssertionError("periodic failure missing");
            } catch (ExecutionException e) {
                check(e.getCause() instanceof IllegalStateException, "wrong periodic cause");
            }
            check(runs.get() == 1 && periodic.isDone(), "failed periodic task continued");
        } finally { stop(p); }
    }
    static class DelayedRunnable implements Runnable, Delayed {
        final long due = System.nanoTime() + TimeUnit.DAYS.toNanos(1);
        final CountDownLatch ran = new CountDownLatch(1);
        public long getDelay(TimeUnit unit) {
            return unit.convert(due - System.nanoTime(), TimeUnit.NANOSECONDS);
        }
        public int compareTo(Delayed other) {
            return Long.compare(getDelay(TimeUnit.NANOSECONDS),
                other.getDelay(TimeUnit.NANOSECONDS));
        }
        public void run() { ran.countDown(); }
    }
    @SuppressWarnings({"unchecked", "rawtypes"})
    static void plainDelayBypass() throws Exception {
        // A deliberately unsuitable queue: demonstrate the firstTask bypass.
        BlockingQueue<Runnable> queue = (BlockingQueue) new DelayQueue<DelayedRunnable>();
        ThreadPoolExecutor p = pool(1, 1, queue, new ThreadPoolExecutor.AbortPolicy());
        try {
            DelayedRunnable task = new DelayedRunnable();
            p.execute(task);
            await(task.ran);
            check(task.getDelay(TimeUnit.SECONDS) > 0, "task no longer delayed");
        } finally { stop(p); }
    }
    static void shutdownPending() throws Exception {
        ThreadPoolExecutor p = pool(1, 1, new ArrayBlockingQueue<>(1),
            new ThreadPoolExecutor.AbortPolicy());
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            p.execute(held(started, release));
            await(started);
            Future<?> queued = p.submit(() -> {});
            List<Runnable> drained = p.shutdownNow();
            check(drained.contains(queued), "queued Future not returned");
            check(!queued.isDone(), "shutdownNow auto-cancelled queued Future");
            queued.cancel(false);
            check(queued.isCancelled(), "explicit cancellation missing");
        } finally { release.countDown(); stop(p); }
    }
    interface Checked { void run() throws Exception; }
    static void run(String label, Checked test) throws Exception {
        test.run();
        System.out.println("PASS " + label);
    }
    public static void main(String[] args) throws Exception {
        run("lazy core creation and prestart", ThreadPoolBehaviorChecks::lazyCore);
        run("2/4/2 admission, queue bypass and rejection", ThreadPoolBehaviorChecks::admission);
        run("unbounded queue prevents normal expansion", ThreadPoolBehaviorChecks::unboundedQueue);
        run("execute/submit results, worker replacement and hook", ThreadPoolBehaviorChecks::results);
        run("CallerRuns execution and shutdown discard", ThreadPoolBehaviorChecks::callerRuns);
        run("Discard leaves unfinished Future", ThreadPoolBehaviorChecks::discardFuture);
        run("scheduled cancellation and periodic failure", ThreadPoolBehaviorChecks::scheduled);
        run("plain pool bypasses DelayQueue for firstTask", ThreadPoolBehaviorChecks::plainDelayBypass);
        run("shutdownNow requires pending Future cancellation", ThreadPoolBehaviorChecks::shutdownPending);
        System.out.println("All 9 checks passed.");
    }
}
