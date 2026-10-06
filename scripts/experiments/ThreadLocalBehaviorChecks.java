import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Public-API behavior checks. No reflection, timing-based GC assertions or load tests. */
public class ThreadLocalBehaviorChecks {
    static final class RequestContext {
        final String userId;
        final String traceId;
        RequestContext(String userId, String traceId) {
            this.userId = userId;
            this.traceId = traceId;
        }
    }
    // Contract: only non-null contexts are stored; null means no active context.
    static final ThreadLocal<RequestContext> CURRENT = new ThreadLocal<>();
    static void install(RequestContext context) {
        if (context == null) CURRENT.remove();
        else CURRENT.set(context);
    }
    static Runnable withContext(RequestContext context, Runnable action) {
        return () -> {
            RequestContext previous = CURRENT.get();
            install(context);
            try {
                action.run();
            } finally {
                install(previous);
            }
        };
    }
    static void check(boolean result, String message) {
        if (!result) throw new AssertionError(message);
    }
    static <T> T result(Future<T> future) throws Exception {
        return future.get(5, TimeUnit.SECONDS);
    }
    static ThreadPoolExecutor worker() {
        return new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(8), Executors.defaultThreadFactory(),
            new ThreadPoolExecutor.AbortPolicy());
    }
    static void stop(ExecutorService pool) throws Exception {
        for (Runnable pending : pool.shutdownNow()) {
            if (pending instanceof Future<?>) ((Future<?>) pending).cancel(false);
        }
        check(pool.awaitTermination(5, TimeUnit.SECONDS), "worker did not stop");
    }
    static void reusedThread() throws Exception {
        ThreadLocal<String> user = new ThreadLocal<>();
        ThreadPoolExecutor pool = worker();
        try {
            Thread first = result(pool.submit(() -> {
                user.set("user-A");
                return Thread.currentThread();
            }));
            String observed = result(pool.submit(() -> user.get()));
            Thread second = result(pool.submit(() -> Thread.currentThread()));
            check(first == second, "tasks did not reuse worker");
            check("user-A".equals(observed), "expected stale request value");
            result(pool.submit(() -> user.remove()));
            check(result(pool.submit(() -> user.get())) == null, "remove missed value");
        } finally { stop(pool); }
    }
    static void cleanupAfterFailure() throws Exception {
        ThreadPoolExecutor pool = worker();
        RequestContext a = new RequestContext("user-A", "trace-A");
        try {
            Future<?> failed = pool.submit(() -> {
                CURRENT.set(a);
                try {
                    throw new IllegalStateException("business failure");
                } finally {
                    CURRENT.remove();
                }
            });
            try {
                result(failed);
                throw new AssertionError("failure missing");
            } catch (ExecutionException e) {
                check(e.getCause() instanceof IllegalStateException, "wrong failure");
            }
            check(result(pool.submit(() -> CURRENT.get())) == null, "failure left context");
        } finally { stop(pool); }
    }
    static void initialization() {
        AtomicInteger sequence = new AtomicInteger();
        ThreadLocal<Integer> local = ThreadLocal.withInitial(sequence::incrementAndGet);
        try {
            check(local.get() == 1, "initial value");
            local.set(null);
            check(local.get() == null && sequence.get() == 1, "set(null) initialized again");
            local.remove();
            check(local.get() == 2, "remove did not reinitialize");
        } finally { local.remove(); }
    }
    static void sharedObject() throws Exception {
        ThreadLocal<List<String>> local = new ThreadLocal<>();
        List<String> shared = new ArrayList<>();
        ThreadPoolExecutor pool = worker();
        local.set(shared);
        try {
            List<String> bound = result(pool.submit(() -> {
                local.set(shared);
                local.get().add("child");
                return local.get();
            }));
            // Writes and reads are ordered by Future.get; this is not concurrent ArrayList use.
            check(bound == local.get(), "object unexpectedly copied");
            check(local.get().contains("child"), "shared mutation missing");
        } finally { local.remove(); stop(pool); }
    }
    static void nestedRestoration() {
        RequestContext outer = new RequestContext("outer-user", "outer");
        RequestContext inner = new RequestContext("inner-user", "inner");
        CURRENT.set(outer);
        try {
            try {
                withContext(inner, () -> {
                    check(CURRENT.get() == inner, "inner not installed");
                    throw new IllegalStateException("inner failure");
                }).run();
                throw new AssertionError("inner exception missing");
            } catch (IllegalStateException expected) {}
            check(CURRENT.get() == outer, "outer context lost");
            withContext(null, () -> check(CURRENT.get() == null, "null not installed")).run();
            check(CURRENT.get() == outer, "null scope lost outer");
        } finally { CURRENT.remove(); }
        withContext(inner, () -> check(CURRENT.get() == inner, "root scope missing")).run();
        check(CURRENT.get() == null, "root scope retained");
        CURRENT.remove(); // get above may initialize a null entry.
    }
    static void snapshotAndCallerRuns() throws Exception {
        ThreadPoolExecutor pool = worker();
        ThreadPoolExecutor saturated = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1), Executors.defaultThreadFactory(),
            new ThreadPoolExecutor.CallerRunsPolicy());
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        RequestContext a = new RequestContext("A", "trace-A");
        RequestContext b = new RequestContext("B", "trace-B");
        RequestContext oldWorker = new RequestContext("background", "worker");
        try {
            pool.prestartAllCoreThreads();
            CURRENT.set(a);
            check(result(pool.submit(() -> CURRENT.get())) == null,
                "ordinary ThreadLocal propagated automatically");
            result(pool.submit(() -> CURRENT.set(oldWorker)));
            AtomicReference<RequestContext> seen = new AtomicReference<>();
            Runnable captured = withContext(CURRENT.get(), () -> seen.set(CURRENT.get()));
            CURRENT.set(b); // Change after capture, before execution.
            result(pool.submit(captured));
            check(seen.get() == a, "snapshot captured too late");
            check(result(pool.submit(() -> CURRENT.get())) == oldWorker,
                "worker previous context not restored");
            check(CURRENT.get() == b, "submitter context changed");
            saturated.execute(() -> {
                started.countDown();
                try {
                    check(release.await(5, TimeUnit.SECONDS), "release timeout");
                } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            });
            check(started.await(5, TimeUnit.SECONDS), "worker startup timeout");
            saturated.execute(() -> {});
            Thread caller = Thread.currentThread();
            AtomicReference<Thread> executionThread = new AtomicReference<>();
            saturated.execute(withContext(a, () -> {
                check(CURRENT.get() == a, "caller task context wrong");
                executionThread.set(Thread.currentThread());
            }));
            check(executionThread.get() == caller, "CallerRuns did not use caller");
            check(CURRENT.get() == b, "CallerRuns lost submitter context");
        } finally {
            release.countDown();
            CURRENT.remove();
            try { stop(pool); } finally { stop(saturated); }
        }
    }
    static void inheritanceAtCreation() throws Exception {
        InheritableThreadLocal<String> inherited = new InheritableThreadLocal<>();
        ThreadPoolExecutor pool = worker();
        try {
            inherited.set("A");
            check("A".equals(result(pool.submit(() -> inherited.get()))),
                "creation did not inherit A");
            inherited.set("B");
            check("A".equals(result(pool.submit(() -> inherited.get()))),
                "existing worker inherited a new task value");
            inherited.remove();
            check("A".equals(result(pool.submit(() -> inherited.get()))),
                "parent remove cleared child binding");
        } finally { inherited.remove(); stop(pool); }
    }
    static void inheritedMutableValue() throws Exception {
        InheritableThreadLocal<List<String>> inherited = new InheritableThreadLocal<>();
        List<String> original = new ArrayList<>();
        ThreadPoolExecutor pool = worker();
        inherited.set(original);
        try {
            List<String> childValue = result(pool.submit(() -> {
                inherited.get().add("child");
                return inherited.get();
            }));
            check(childValue == original && original.contains("child"),
                "default inheritance unexpectedly deep-copied");
            List<String> replacement = new ArrayList<>();
            inherited.set(replacement);
            check(result(pool.submit(() -> inherited.get())) == original,
                "parent rebind changed child binding");
        } finally { inherited.remove(); stop(pool); }
    }
    interface Checked { void run() throws Exception; }
    static void run(String name, Checked test) throws Exception {
        test.run();
        System.out.println("PASS " + name);
    }
    public static void main(String[] args) throws Exception {
        run("same worker retains live-key request value", ThreadLocalBehaviorChecks::reusedThread);
        run("finally removes context after failure", ThreadLocalBehaviorChecks::cleanupAfterFailure);
        run("set(null) versus remove and initialization", ThreadLocalBehaviorChecks::initialization);
        run("separate bindings can share one mutable object", ThreadLocalBehaviorChecks::sharedObject);
        run("nested scopes restore outer context", ThreadLocalBehaviorChecks::nestedRestoration);
        run("capture at submission and restore under CallerRuns", ThreadLocalBehaviorChecks::snapshotAndCallerRuns);
        run("inheritance happens at thread creation, not each task", ThreadLocalBehaviorChecks::inheritanceAtCreation);
        run("default inheritance shares value, parent rebind does not", ThreadLocalBehaviorChecks::inheritedMutableValue);
        System.out.println("All 8 checks passed.");
    }
}
