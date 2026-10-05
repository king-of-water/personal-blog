---
title: 动态代理：JDK 代理与 CGLIB
description: 从 Proxy.newProxyInstance 的三个参数讲起，拆开生成的 $Proxy0 类长什么样、InvocationHandler 怎么被回调；再讲 CGLIB 的 Enhancer 三步、生成的子类结构、MethodProxy 与 invokeSuper/invoke 的区别和 FastClass 机制；对比两者的限制、性能，以及 Spring AOP 的选择规则和自调用事务失效。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 30
featured: true
publishedAt: 2026-06-06T14:00:00+08:00
updatedAt: 2026-06-06T14:00:00+08:00
tags: [Java, 动态代理, JDK 代理, CGLIB, InvocationHandler, MethodInterceptor, Proxy, Spring AOP, 字节码, FastClass]
---

想在"每个方法调用前后打日志"而不改原类，怎么办？直接在每个方法里写日志，是复制粘贴的灾难；继承重写所有方法，又受 `final` 和类的限制。动态代理就是为解决这类"横切关注点"而生的——它在运行时生成一个代理对象，替你包住真实对象，所有方法调用都先经过代理，代理再决定要不要调用、调用前后做什么。

动态代理是 Spring AOP、MyBatis Mapper、RPC 远程调用桩这些技术共同的地基。理解它，就理解了"为什么 Spring 能给你的 Service 自动加事务、加日志"。

本文回答一个问题：动态代理到底怎么"在运行时生成一个能拦截方法调用的对象"，JDK 动态代理和 CGLIB 两种实现各有什么边界，实际工程里怎么选。为了讲清机制，我们会把**生成的代理类反编译出来看**——那才是动态代理的真面目。主要依据 JDK 源码与 Spring 文档。

## 一、动态代理的本质：包一层，拦一道

静态代理是手写一个代理类，它和真实类实现同一个接口，内部持有一个真实对象，每个方法里转发调用：

```java
class UserServiceProxy implements UserService {
    private final UserService target;          // 持有真实对象
    UserServiceProxy(UserService target) { this.target = target; }

    @Override
    public void save(User u) {
        System.out.println("before");          // 增强逻辑
        target.save(u);                        // 转发真实调用
        System.out.println("after");
    }
    // 真实类每加一个方法，这里就得跟着加一个一模一样的转发方法
}
```

问题很明显：真实类每加一个方法，代理类就得跟着加一个转发方法，方法一多就爆炸。而且这段转发代码和业务完全无关，纯属重复劳动。

动态代理把"手写代理类"换成"**运行时生成代理类**"。你要做的只是提供一个拦截逻辑（一个回调），JVM 或字节码库在运行时帮你生成那个代理类、创建代理对象。之后你对代理对象的每次方法调用，都会先进入你的拦截逻辑，由你决定是否调用真实对象、调用前后做什么。

![动态代理在真实对象外包一层拦截](/images/posts/java-proxy-mechanism.svg)

这张图是动态代理的通用模型，不区分实现：调用方拿到的是代理对象（长得和真实对象一样），调用它的方法，请求先到拦截器，拦截器可以记录日志、做校验、开事务，然后转发给真实对象。真实对象不知道自己被代理了——这正是"不改原类"的关键。

下面分别看两种实现各自**生成了什么**。

## 二、JDK 动态代理：只能代理接口

JDK 内置的动态代理靠 `java.lang.reflect.Proxy` 和 `InvocationHandler` 两个类实现。

```java
interface UserService {
    void save(User u);
}

UserService target = new UserServiceImpl();
UserService proxy = (UserService) Proxy.newProxyInstance(
    target.getClass().getClassLoader(),
    new Class<?>[]{UserService.class},
    (proxyObj, method, args) -> {
        System.out.println("before: " + method.getName());
        Object result = method.invoke(target, args);   // 反射调用真实对象
        System.out.println("after: " + method.getName());
        return result;
    });
proxy.save(user);   // 实际先经过 InvocationHandler
```

### newProxyInstance 的三个参数

这个方法签名是 `newProxyInstance(ClassLoader loader, Class<?>[] interfaces, InvocationHandler h)`，三个参数各有各的作用，不能随手传：

- **`loader`（类加载器）**：用来**定义并加载生成的代理类**。为什么通常传目标类的类加载器？因为代理类需要 `implements` 你给的那些接口，它必须和这些接口"在同一个可见世界里"——用目标类的加载器，才能保证代理类看得到目标类实现的那些接口类型。
- **`interfaces`（接口数组）**：代理类要实现的接口列表。生成的代理类会 `implements` 这里的每一个接口，所以调用方才能把它当成 `UserService` 使用。注意是**数组**——一个代理对象可以同时实现多个接口。
- **`h`（调用处理器）**：也就是你自己的拦截逻辑。代理类的每个方法都会转发到 `h.invoke(...)`，这是唯一的"业务入口"。

### 生成的代理类长什么样

这是理解 JDK 动态代理最关键的一步。`newProxyInstance` 返回的那个对象，它的**实际类型**是运行时生成的一个类，通常叫 `$Proxy0`（用 `-Djdk.proxy.ProxyGenerator.saveGeneratedFiles=true` 可以把生成的 class 文件 dump 出来）。反编译后大概长这样：

```java
public final class $Proxy0 extends Proxy implements UserService {
    private static Method m3;      // 对应 save 方法

    public $Proxy0(InvocationHandler h) {
        super(h);                  // Proxy 父类里存着 protected InvocationHandler h
    }

    static {
        // 静态初始化时，把接口方法反射拿到手，缓存成 Method 对象
        m3 = Class.forName("UserService").getMethod("save", User.class);
    }

    @Override
    public final void save(User u) {
        try {
            super.h.invoke(this, m3, new Object[]{u});   // 唯一的一行：转发给 handler
        } catch (Throwable e) {
            throw new UndeclaredThrowableException(e);
        }
    }
}
```

看懂这个类，JDK 动态代理就没什么秘密了：

- 它 **`extends Proxy`**，`Proxy` 父类里有一个 `protected InvocationHandler h` 字段，构造器把外部传进来的 handler 存进去；
- 它 **`implements UserService`**，所以能被强转成 `UserService`；
- 每个接口方法的**方法体只有一行**：`super.h.invoke(this, m3, args)`——把"哪个对象、哪个方法、什么参数"打包交给 handler；
- `this` 就是代理对象自己，这也是 `invoke` 第一个参数 `proxy` 的来源；
- 受检异常被包成 `UndeclaredThrowableException`（因为接口方法没声明这个异常，代理方法不能直接抛）。

![JDK 动态代理生成的 $Proxy0 类与调用链](/images/posts/jdk-proxy-generated-class.svg)

### InvocationHandler.invoke 的三个参数

handler 里那个 `invoke(Object proxy, Method method, Object[] args)` 同样三个参数，各有含义：

- **`proxy`**：代理对象本身。**这里有个坑**——如果你在 handler 里对 `proxy` 调用方法，会再次进入 `invoke`，形成递归。所以它通常只用来返回或做类型判断，不用来转发调用。
- **`method`**：被调用的方法对象（`java.lang.reflect.Method`）。你可以从这里拿到 `method.getName()`、`method.getAnnotation(...)`（Spring 的 `@Transactional` 就是在这里被读出来的）、参数类型等元信息——这正是"声明式事务、缓存注解"能生效的地方。
- **`args`**：实参数组。无参方法时它是 `null`（不是空数组），写拦截逻辑时要留意。

转发真实调用用的是 `method.invoke(target, args)`，这是**反射调用**。反射在 JDK 7 之前很慢，JDK 7 之后做了优化（`MethodHandle`、调用点缓存），性能差距被拉近，但本质仍是反射转发——这个"反射"二字，是后面和 CGLIB 对比时的关键差异。

### 为什么只能代理接口

这里有个硬限制：JDK 动态代理**只能代理接口**。原因就藏在上面的类声明里——生成的代理类已经 `extends Proxy` 了，而 **Java 是单继承**，它没法再去 `extends` 你的具体类，只能退而求其次去 `implements` 你指定的接口。

所以目标对象必须实现至少一个接口，否则 JDK 动态代理根本用不了。这是使用前的第一道门槛。

## 三、CGLIB：用字节码生成子类

CGLIB 走的是另一条路：它不要求接口，而是通过字节码操作（底层是 ASM）**生成目标类的子类**，子类重写所有非 `final` 方法，在重写的方法里插入拦截逻辑。

```java
Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(UserServiceImpl.class);      // ① 指定父类（被代理类）
enhancer.setCallback((MethodInterceptor) (obj, method, args, methodProxy) -> {
    System.out.println("before: " + method.getName());
    Object result = methodProxy.invokeSuper(obj, args);  // ② 调用父类（真实）方法
    System.out.println("after: " + method.getName());
    return result;
});
UserServiceImpl proxy = (UserServiceImpl) enhancer.create();   // ③ 生成子类并实例化
proxy.save(user);
```

### Enhancer 的三步

这三步各自在做一件明确的事：

- **`setSuperclass(...)`**：告诉 CGLIB"要代理哪个类"，也就是生成的子类的父类是谁。这一步决定了 CGLIB 的能力边界——父类不能是 `final`，否则连继承都做不到。
- **`setCallback(...)`**：设置回调，也就是拦截逻辑。CGLIB 的拦截器接口叫 `MethodInterceptor`，方法签名是 `intercept(Object obj, Method method, Object[] args, MethodProxy proxy)`——比 JDK 的 `invoke` 多了一个 `MethodProxy` 参数，这个多出来的参数正是 CGLIB 性能优势的来源（下面讲）。
- **`create()`**：真正干活的步骤——生成子类字节码、用类加载器加载、实例化并返回代理对象。这一步是**有成本的**（生成 + 加载类），所以 CGLIB 代理对象通常要缓存复用，不能每次调用都 `create()`。

### 生成的子类长什么样

同样把它"反编译"出来看，CGLIB 生成的类大致是这样：

```java
public class UserServiceImpl$$EnhancerByCGLIB extends UserServiceImpl {
    private MethodInterceptor interceptor;      // 你设的回调
    private static Method m_save;
    private static MethodProxy mp_save;         // 关键：FastClass 用的方法代理

    @Override
    public void save(User u) {
        MethodInterceptor tmp = this.interceptor;
        if (tmp != null) {
            tmp.intercept(this, m_save, new Object[]{u}, mp_save);   // 转发给拦截器
            return;
        }
        super.save(u);                          // 没拦截器就走真实方法
    }
}
```

和 `$Proxy0` 对比着看，差异一目了然：

- `$Proxy0` 是 **`extends Proxy implements UserService`**——它是真实类的"兄弟"，所以内部还得**持有一个真实对象**来转发；
- CGLIB 的子类是 **`extends UserServiceImpl`**——它是真实类的"儿子"，重写方法里用 `super.save(u)` 就能调到真实逻辑，**不需要持有目标对象**。

这个"兄弟 vs 儿子"的差别，是两种实现所有差异的根源。

![CGLIB 生成的子类结构与 invokeSuper / invoke 的分叉](/images/posts/cglib-generated-subclass.svg)

### MethodProxy 与 invokeSuper / invoke

`MethodInterceptor` 比 JDK 的 `InvocationHandler` 多了一个 `MethodProxy proxy` 参数，它是 CGLIB 的性能关键。

`MethodProxy` 背后是 **FastClass** 机制：CGLIB 会为父类额外生成一个"索引类"，把每个方法映射成一个下标，调用时按**下标直接跳转**，而不是像反射那样先做方法查找、再做访问检查。所以 `invokeSuper` 走的是"字节码直接调用"，绕开了反射开销。

**但这里有个经典坑，必须记牢：**

- **`methodProxy.invokeSuper(obj, args)`**：调用 `obj` 的**父类**（真实类）方法 → 这是我们想要的转发；
- **`methodProxy.invoke(obj, args)`**：调用 `obj` **自己**的方法。而在拦截器里，`obj` 就是**代理对象**——于是调用会再次进入 `intercept`，无限递归，直到 `StackOverflowError`。

```java
// ✗ 错误：obj 是代理对象，invoke 会再次进入 intercept → 无限递归
methodProxy.invoke(obj, args);

// ✓ 正确：invokeSuper 调到父类（真实类）的实现
methodProxy.invokeSuper(obj, args);
```

一句话记住：**在拦截器里转发真实调用，永远用 `invokeSuper`**。`invoke` 是留给"你手上拿的是原始目标对象、而不是代理对象"的场景的。

### CGLIB 的完整限制清单

因为 CGLIB 靠"继承 + 重写"，凡是继承和重写做不到的，它都代理不了：

| 目标 | 能否代理 | 原因 |
| --- | --- | --- |
| `final` 类 | ✗ | 无法被继承，生成不出子类 |
| `final` 方法 | ✗ | 无法被重写，插不进拦截逻辑 |
| `private` 方法 | ✗ | 子类看不到父类的私有方法，谈不上重写 |
| `static` 方法 | ✗ | 静态方法属于类而非对象，不参与多态 |
| 构造器 | ✗ | 构造过程无法用子类重写拦截 |
| 普通 public / protected 方法 | ✓ | 可被重写 |

对比 JDK 动态代理的限制则简单得多：**只能代理接口**（以及非 public 接口必须与代理类同包）。

## 四、两者的边界：继承关系的差异

两者最本质的区别在继承关系上，看这张图比看文字清楚：

![JDK 代理靠实现接口，CGLIB 靠继承子类](/images/posts/jdk-vs-cglib.svg)

JDK 动态代理的代理类和真实类是"兄弟"——都实现同一个接口，代理内部持有真实对象、转发调用；CGLIB 的代理类是真实类的"儿子"——继承真实类、重写方法。这个继承关系的差异，直接决定了它们的限制：单继承逼得 JDK 代理只能面向接口，继承又让 CGLIB 拿 `final` 没办法。

| 维度 | JDK 动态代理 | CGLIB |
| --- | --- | --- |
| 代理对象是什么 | 实现接口的新类（`extends Proxy implements X`） | 目标类的子类（`extends X`） |
| 是否持有目标对象 | 是，需要它来转发 | 否，`super` 调用即可 |
| 对目标的要求 | 必须实现至少一个接口 | 类不能是 final，方法不能是 final |
| 方法调用方式 | 反射（`method.invoke`） | 字节码索引调用（FastClass + `invokeSuper`） |
| 生成时机 | `newProxyInstance` 时 | `enhancer.create()` 时（成本更高，需缓存） |
| 依赖 | JDK 内置，零依赖 | 需引入 CGLIB + ASM |
| 典型使用 | 接口明确的场景 | 无接口的类 |
| `proxy instanceof 目标类` | `false`（只能按接口判断） | `true`（子类 is-a 父类） |

## 五、性能：反射 vs 字节码

历史上"CGLIB 比 JDK 代理快"的说法，根源就在调用方式上：

- **JDK 代理**每个方法要经过 `h.invoke(this, m3, args)`，再 `method.invoke(target, args)`——一次反射调用。反射要做方法查找和访问检查，早期版本（JDK 7 之前）确实慢。
- **CGLIB**生成的是真正的子类方法，`invokeSuper` 通过 FastClass 索引直接跳转，没有反射开销。

但现代 JDK 上这个差距已经很小了：JDK 7 之后反射做了大量优化（调用点缓存、`MethodHandle`、字节码生成），JDK 8 的 JDK 代理在预热后性能已经和 CGLIB 接近。

更重要的是**权衡的另一面**：CGLIB 生成类本身很贵（生成字节码 + 定义类 + 加载），启动阶段的开销明显大于 JDK 代理；而且生成大量代理类会占用 Metaspace。所以现在的实践里，**选择依据基本不再是性能，而是"目标有没有接口"和"框架默认值"**——性能只在极端高频调用的场景下才值得单独测。

## 六、Spring AOP 怎么选

Spring AOP 内部就用这两种动态代理，选择规则和上面一致：目标实现了接口，默认用 JDK 动态代理；目标没实现接口，退到 CGLIB。

一个容易搞混的点是 Spring Boot 的默认值。Spring Boot 2.0 起，`spring.aop.proxy-target-class` 默认是 `true`，意味着**默认优先用 CGLIB**，即使目标实现了接口。这个默认值的理由是 CGLIB 行为更统一（不用关心目标到底有没有接口），也避免某些场景下"接口代理"和"类代理"混用导致的坑。但如果你明确只用接口编程，也可以设回 `false` 用 JDK 动态代理。

所以"Spring AOP 用 JDK 还是 CGLIB"的答案分两层：**Spring 框架本身的规则是"有接口用 JDK、没接口用 CGLIB"；Spring Boot 则默认直接用 CGLIB**。这解释了为什么很多人以为"Spring 就是 CGLIB"，其实只是 Boot 改了默认值。

### 一个必须知道的坑：自调用会让增强失效

动态代理的机制决定了：**只有"从代理对象进去"的调用才会被拦截**。于是一个类内部的方法互相调用，就会绕过代理：

```java
@Service
public class UserService {
    @Transactional
    public void outer() {
        this.inner();          // ✗ 自调用：this 是真实对象，不走代理
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void inner() {
        // 期望开启新事务，实际不会——inner 的增强根本没触发
    }
}
```

`outer()` 里写 `this.inner()`，`this` 指向的是**真实对象**（不是代理对象），所以 `inner()` 上的一切增强（事务、缓存、日志）都不会生效。这就是"`@Transactional` 自调用失效"的完整原因——不是注解没写对，是调用根本没经过代理。

![自调用绕过代理导致事务失效](/images/posts/spring-aop-self-invocation.svg)

三种常见解法：

1. **拆到另一个 Bean**：把 `inner()` 放到独立的 Service 里注入进来调——最干净，推荐；
2. **注入自己**：`@Autowired private UserService self;` 然后用 `self.inner()`，这时 `self` 是代理对象；
3. **`AopContext.currentProxy()`**：需要开启 `@EnableAspectJAutoProxy(exposeProxy = true)`，然后用 `((UserService) AopContext.currentProxy()).inner()`。

理解了这个坑，也就真正理解了动态代理的边界：**代理只在"方法调用的入口"起作用，进去之后的内部调用，代理管不着**。

动态代理的价值不在"包一层"这个动作，而在它把"横切逻辑"从业务代码里抽了出来。事务、日志、权限、缓存、远程调用，这些和业务本身无关、却要在每个方法前后做的事，正是因为有了动态代理，才能"不改原类"地统一织入。而它的两种实现——JDK 代理靠"实现接口"、CGLIB 靠"继承子类"——各自的限制，也都源于同一条语言规则：Java 单继承。理解了这条线，Spring 那一堆 `@Transactional`、`@Cacheable` 注解，就不再是魔法。

## 参考资料

- [Oracle：Proxy（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/lang/reflect/Proxy.html)
- [Oracle：InvocationHandler（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/lang/reflect/InvocationHandler.html)
- [Spring Framework：AOP Proxies](https://docs.spring.io/spring-framework/reference/core/aop/proxying.html)
- [cglib：Github](https://github.com/cglib/cglib)
